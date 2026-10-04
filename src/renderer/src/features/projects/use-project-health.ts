import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ProjectHealthMode,
  ProjectHealthProgress,
  ProjectHealthReport,
} from '../../../../shared/project-health';
import { refreshRestoredMedia } from '../workspace/use-media-revision';

/** One project-scoped inspection; cancelled or unmounted work cannot replace its last report. */
export function useProjectHealth(projectId: string, disabled: boolean) {
  const [report, setReport] = useState<ProjectHealthReport | null>(null);
  const [progress, setProgress] = useState<ProjectHealthProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(false);
  const pending = useRef<Promise<void> | null>(null);
  const cancelled = useRef(false);
  const inspected = useRef(false);
  const run = useCallback(
    async (operation: () => Promise<ProjectHealthReport | null>) => {
      if (pending.current) return;
      cancelled.current = false;
      setBusy(true);
      setError(null);
      setNotice(null);
      setProgress(null);
      const task = (async () => {
        try {
          const next = await operation();
          if (mounted.current && !cancelled.current && next)
            setReport((previous) => {
              if (next.mode === 'full' || !previous) return next;
              const currentIssues = new Set(
                next.issues.map((issue) => issue.assetId),
              );
              // A location-only scan cannot prove that a previously changed file is repaired.
              return {
                ...next,
                issues: [
                  ...next.issues,
                  ...previous.issues.filter(
                    (issue) =>
                      issue.problem === 'changed' &&
                      !currentIssues.has(issue.assetId),
                  ),
                ],
              };
            });
        } catch (reason) {
          if (mounted.current && !cancelled.current)
            setError(
              (reason instanceof Error
                ? reason.message
                : String(reason)
              ).replace(
                /^Error invoking remote method '[^']+': (Error: )?/,
                '',
              ),
            );
        } finally {
          pending.current = null;
          if (mounted.current) {
            setBusy(false);
            setProgress(null);
          }
        }
      })();
      pending.current = task;
      await task;
    },
    [],
  );
  const scan = useCallback(
    (mode: ProjectHealthMode) =>
      run(() => window.desktop.scanProjectHealth(projectId, mode)),
    [projectId, run],
  );
  useEffect(() => {
    mounted.current = true;
    const stop = window.desktop.onProjectHealthProgress((state) => {
      if (
        mounted.current &&
        pending.current &&
        (!state || state.projectId === projectId)
      )
        setProgress(state);
    });
    return () => {
      mounted.current = false;
      cancelled.current = true;
      stop();
      if (pending.current)
        void window.desktop.cancelProjectHealth().catch(() => {});
    };
  }, [projectId]);
  useEffect(() => {
    if (disabled || inspected.current) return;
    // StrictMode's setup/cleanup probe must not consume the one automatic check.
    const timer = setTimeout(() => {
      inspected.current = true;
      void scan('quick');
    }, 0);
    return () => clearTimeout(timer);
  }, [disabled, scan]);
  return {
    report,
    progress,
    busy,
    error,
    notice,
    scan,
    restore: (assetId: string) =>
      run(async () => {
        const restored = await window.desktop.restoreMissingAsset(
          projectId,
          assetId,
        );
        if (!restored) return null;
        refreshRestoredMedia(projectId, assetId);
        if (cancelled.current) return null;
        // A quick refresh must not hide same-sized changes found by a previous full check.
        return report?.mode === 'full'
          ? window.desktop.scanProjectHealth(projectId, 'full')
          : restored;
      }),
    cancel: async () => {
      cancelled.current = true;
      setNotice('已取消处理，保留上一次完成的检查结果。');
      try {
        await window.desktop.cancelProjectHealth();
      } catch (reason) {
        if (mounted.current)
          setError(reason instanceof Error ? reason.message : String(reason));
      }
    },
  };
}
