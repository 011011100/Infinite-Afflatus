import { useCallback, useEffect, useRef, useState } from 'react';
import type { SequenceExportJob } from '../../../../shared/export';

export const exportRunning = (job: SequenceExportJob) =>
  ['queued', 'preparing', 'encoding', 'finalizing'].includes(job.status);

export function useExports() {
  const [jobs, setJobs] = useState<SequenceExportJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const report = useCallback((reason: unknown) => {
    if (mounted.current)
      setError(
        reason instanceof Error
          ? reason.message.replace(
              /^Error invoking remote method '[^']+': (Error: )?/,
              '',
            )
          : String(reason),
      );
  }, []);
  const refresh = useCallback(async () => {
    const next = await window.desktop.listExports();
    if (mounted.current) setJobs(next);
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (!window.desktop?.listExports) return;
    let reading = false;
    let again = false;
    const update = async () => {
      if (reading) {
        again = true;
        return;
      }
      reading = true;
      do {
        again = false;
        try {
          await refresh();
        } catch (reason) {
          report(reason);
        }
      } while (again && mounted.current);
      reading = false;
    };
    void update();
    const stop = window.desktop.onExportsChanged(() => void update());
    return () => {
      mounted.current = false;
      stop();
    };
  }, [refresh, report]);
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (reason) {
      report(reason);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return { jobs, error, busy, run };
}
