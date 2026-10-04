import { useEffect, useRef, useState } from 'react';
import type { SaveJob } from '../../../../shared/models';
import type { StagingItem } from '../../../../shared/staging-cleanup';
import { message } from '../generation/errors';

type CheckedJob = { signature: string; item: StagingItem };

/** Unrelated library refreshes retain verified retry actions; changed jobs never reuse them. */
export function useStagingInspection(jobs: SaveJob[]) {
  const failed = jobs.filter((job) => job.status === 'failed');
  const signature = JSON.stringify(failed);
  const [checked, setChecked] = useState<Map<string, CheckedJob>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const epoch = useRef(0);
  const [refresh, setRefresh] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry repeats this read-only inspection without changing jobs.
  useEffect(() => {
    const request = ++epoch.current;
    const snapshot = JSON.parse(signature) as SaveJob[];
    if (!snapshot.length) {
      setChecking(false);
      setError(null);
      return;
    }
    // A StrictMode setup/cleanup probe should not launch an extra disk inspection.
    const timer = setTimeout(() => {
      setChecking(true);
      void window.desktop.inspectStaging().then(
        (report) => {
          if (epoch.current !== request) return;
          const byId = new Map(report.items.map((item) => [item.jobId, item]));
          setChecked(
            new Map(
              snapshot.flatMap((job) => {
                const item = byId.get(job.id);
                return item
                  ? [[job.id, { signature: JSON.stringify(job), item }]]
                  : [];
              }),
            ),
          );
          setError(null);
          setChecking(false);
        },
        (reason) => {
          if (epoch.current !== request) return;
          setError(message(reason));
          setChecking(false);
        },
      );
    }, 0);
    return () => {
      clearTimeout(timer);
      epoch.current++;
    };
  }, [signature, refresh]);
  return {
    checking,
    error,
    refresh: () => setRefresh((value) => value + 1),
    itemFor: (job: SaveJob) => {
      const cached = checked.get(job.id);
      return cached?.signature === JSON.stringify(job) ? cached.item : null;
    },
  };
}
