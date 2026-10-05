import { useCallback, useEffect, useRef, useState } from 'react';
import { flushPendingChanges } from '@/features/lifecycle/pending-saves';
import type { ProjectPackageProgress } from '../../../../shared/project-package';
import { projectErrorMessage } from './library-session';
import {
  packageRequestsPaused,
  registerPackageRequest,
} from './local-package-requests';

type Attempt = {
  id: string;
  cancelling: boolean;
  nativeStarted: boolean;
  error: unknown;
  promise: Promise<unknown>;
  nativeCancellation: Promise<void> | null;
};

export function useProjectPackageOperation(report?: (reason: unknown) => void) {
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<ProjectPackageProgress | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Attempt | null>(null);
  const epoch = useRef(0);
  const latestReport = useRef(report);
  latestReport.current = report;

  const cancelAttempt = useCallback((attempt: Attempt) => {
    if (!attempt.cancelling) {
      attempt.cancelling = true;
      if (pending.current === attempt) setCancelling(true);
      // There is no native request yet while the renderer saves existing edits.
      // The local flag prevents that request from starting after the save settles.
      attempt.nativeCancellation = attempt.nativeStarted
        ? window.desktop.cancelProjectPackage(attempt.id).catch((reason) => {
            attempt.error = reason;
          })
        : Promise.resolve();
    }
    return Promise.all([attempt.nativeCancellation, attempt.promise]).then(
      () => {
        if (attempt.error) throw attempt.error;
      },
    );
  }, []);

  useEffect(() => {
    epoch.current++;
    const stop = window.desktop.onProjectPackageProgress((value) => {
      if (pending.current?.id === value.requestId) setProgress(value);
    });
    return () => {
      epoch.current++;
      stop();
      const attempt = pending.current;
      pending.current = null;
      if (attempt) void cancelAttempt(attempt).catch(() => {});
    };
  }, [cancelAttempt]);

  const run = useCallback(
    <T>(
      operation: (requestId: string) => Promise<T | null>,
      success: (value: T) => string | null,
      saveFirst = true,
    ): Promise<T | null> => {
      if (pending.current || packageRequestsPaused())
        return Promise.resolve(null);
      const currentEpoch = epoch.current;
      const attempt: Attempt = {
        id: crypto.randomUUID(),
        cancelling: false,
        nativeStarted: false,
        error: null,
        promise: Promise.resolve(),
        nativeCancellation: null,
      };
      pending.current = attempt;
      const current = () =>
        epoch.current === currentEpoch && pending.current === attempt;
      setBusy(true);
      setSaving(saveFirst);
      setCancelling(false);
      setProgress(null);
      setNotice(null);
      setError(null);
      const unregister = registerPackageRequest(() => cancelAttempt(attempt));
      const result = Promise.resolve()
        .then(async () => {
          let value: T | null = null;
          try {
            if (!attempt.cancelling && saveFirst) {
              const saved = await flushPendingChanges();
              if (!attempt.cancelling && !saved)
                throw new Error('还有修改未保存，请先重试保存。');
            }
            if (!attempt.cancelling && current()) {
              setSaving(false);
              attempt.nativeStarted = true;
              value = await operation(attempt.id);
            }
          } catch (reason) {
            attempt.error = reason;
          }
          // A cancel acknowledgement is not completion. Wait for the operation and
          // its cleanup; a non-null published result always remains a success.
          await attempt.nativeCancellation;
          if (current()) {
            if (value !== null) setNotice(success(value));
            else if (!attempt.error) setNotice('项目包操作已取消。');
            if (attempt.error) {
              setError(projectErrorMessage(attempt.error));
              latestReport.current?.(attempt.error);
            }
          }
          return value;
        })
        .finally(() => {
          unregister();
          if (current()) {
            pending.current = null;
            setBusy(false);
            setSaving(false);
            setCancelling(false);
            setProgress(null);
          }
        });
      attempt.promise = result;
      return result;
    },
    [cancelAttempt],
  );
  const cancel = useCallback(async () => {
    const attempt = pending.current;
    if (attempt) await cancelAttempt(attempt).catch(() => {});
  }, [cancelAttempt]);
  return { busy, saving, cancelling, progress, notice, error, run, cancel };
}

export type ProjectPackageOperationState = ReturnType<
  typeof useProjectPackageOperation
>;
