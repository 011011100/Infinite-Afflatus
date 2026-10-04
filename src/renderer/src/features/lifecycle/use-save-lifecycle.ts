import { useCallback, useEffect, useRef, useState } from 'react';
import { capturePendingSaves, flushPendingChanges } from './pending-saves';

type SaveAttempt = {
  epoch: number;
  keepFrozen: boolean;
  referencePause: string | null;
  promise: Promise<boolean>;
};

async function releaseReferencePause(attempt: SaveAttempt): Promise<void> {
  const token = attempt.referencePause;
  if (!token) return;
  attempt.referencePause = null;
  await window.desktop.resumeReferenceSaves(token);
}

export function useSaveLifecycle() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<SaveAttempt | null>(null);
  const epoch = useRef(0);
  const prepare = useCallback((nativeClose = false) => {
    const previous = pending.current;
    if (previous && previous.epoch === epoch.current) {
      if (nativeClose) previous.keepFrozen = true;
      return previous.promise;
    }
    const currentEpoch = ++epoch.current;
    setSaving(true);
    setError(null);
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
    const captured = capturePendingSaves();
    let successful = false;
    const attempt: SaveAttempt = {
      epoch: currentEpoch,
      keepFrozen: nativeClose,
      referencePause: null,
      promise: Promise.resolve()
        .then(async () => {
          // Long reads/copies share the write gate. Release them before waiting
          // for drafts, including an older save pass already queued behind them.
          const cancellations = await Promise.allSettled([
            window.desktop.prepareReferenceImportsForLeave().then((token) => {
              attempt.referencePause = token;
            }),
            window.desktop?.cancelProjectHealth?.(),
            window.desktop?.cancelProjectPackage?.(),
            window.desktop?.cancelExportPreparation?.(),
            window.desktop.cancelStagingOperations(),
          ]);
          const failed = cancellations.find(
            (result) => result.status === 'rejected',
          );
          if (failed?.status === 'rejected') throw failed.reason;
          // A timed-out pass may already have scanned an editor that the user has
          // since changed. Drain it, then scan every editor again while frozen.
          await previous?.promise;
          if (epoch.current !== currentEpoch) return false;
          const completed = await captured;
          const flushed = await flushPendingChanges();
          const saved = completed && flushed;
          if (epoch.current !== currentEpoch) return false;
          if (!saved)
            setError('仍有修改未保存，已保留当前页面。请检查保存提示后重试。');
          if (!saved || !attempt.keepFrozen) setSaving(false);
          successful = saved;
          return saved;
        })
        .catch(() => {
          if (epoch.current === currentEpoch) {
            setSaving(false);
            setError('未能确认全部修改已保存，已保留当前页面。请重试保存。');
          }
          return false;
        })
        .finally(async () => {
          // Tokens are independent: an old timeout may release only its pause,
          // never the pause belonging to a newer close request.
          if (
            epoch.current !== currentEpoch ||
            !successful ||
            !attempt.keepFrozen
          ) {
            try {
              await releaseReferencePause(attempt);
            } catch {
              if (epoch.current === currentEpoch)
                setError('素材仍在等待保存，请重试保存或重新打开应用。');
            }
          }
          // After a successful native acknowledgement stay frozen until the
          // window closes; another save request must not reopen editing meanwhile.
          if (
            pending.current === attempt &&
            !(successful && attempt.keepFrozen)
          )
            pending.current = null;
        }),
    };
    pending.current = attempt;
    return attempt.promise;
  }, []);
  useEffect(
    () => window.desktop?.onSaveBeforeLeave?.(() => prepare(true)),
    [prepare],
  );
  useEffect(
    () =>
      window.desktop?.onLeaveCancelled?.(() => {
        epoch.current += 1;
        const attempt = pending.current;
        if (attempt)
          void releaseReferencePause(attempt).catch(() => {
            // The existing timeout notice keeps the failed attempt visible.
          });
        setSaving(false);
        setError('保存尚未完成，窗口已保留。请等待或重试保存后再次关闭。');
      }),
    [],
  );
  return { saving, error, prepare, retry: () => prepare() };
}
