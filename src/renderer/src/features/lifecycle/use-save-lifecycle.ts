import { useCallback, useEffect, useRef, useState } from 'react';
import { pausePackageOperations } from '../projects/package-leave-pause';
import { capturePendingSaves, flushPendingChanges } from './pending-saves';
import { useSaveFocus } from './use-save-focus';

type SaveAttempt = {
  epoch: number;
  keepFrozen: boolean;
  referencePause: string | null;
  packages: ReturnType<typeof pausePackageOperations>;
  promise: Promise<boolean>;
};

async function releasePauses(attempt: SaveAttempt): Promise<void> {
  const reference = attempt.referencePause;
  attempt.referencePause = null;
  const results = await Promise.allSettled([
    ...(reference ? [window.desktop.resumeReferenceSaves(reference)] : []),
    attempt.packages.release(),
  ]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}

export function useSaveLifecycle() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<SaveAttempt | null>(null);
  const epoch = useRef(0);
  const focus = useSaveFocus(saving, epoch);
  const prepare = useCallback(
    (nativeClose = false) => {
      const previous = pending.current;
      if (previous && previous.epoch === epoch.current) {
        if (nativeClose) previous.keepFrozen = true;
        return previous.promise;
      }
      const currentEpoch = ++epoch.current;
      focus.begin(currentEpoch);
      setSaving(true);
      setError(null);
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
      const captured = capturePendingSaves();
      const packages = pausePackageOperations();
      let successful = false;
      const attempt: SaveAttempt = {
        epoch: currentEpoch,
        keepFrozen: nativeClose,
        referencePause: null,
        packages,
        promise: Promise.resolve()
          .then(async () => {
            // Long reads/copies share the write gate. Release them before waiting
            // for drafts, including an older save pass already queued behind them.
            const cancellations = await Promise.allSettled([
              window.desktop.prepareReferenceImportsForLeave().then((token) => {
                attempt.referencePause = token;
              }),
              window.desktop?.cancelProjectHealth?.(),
              packages.ready,
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
              setError(
                '仍有修改未保存，已保留当前页面。请检查保存提示后重试。',
              );
            if (!saved || !attempt.keepFrozen) {
              setSaving(false);
              focus.restore(currentEpoch);
            }
            successful = saved;
            return saved;
          })
          .catch(() => {
            if (epoch.current === currentEpoch) {
              setSaving(false);
              focus.restore(currentEpoch);
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
                await releasePauses(attempt);
              } catch {
                if (epoch.current === currentEpoch)
                  setError(
                    '保存或项目包操作仍暂停，请重试保存或重新打开应用。',
                  );
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
    },
    [focus],
  );
  useEffect(
    () => window.desktop?.onSaveBeforeLeave?.(() => prepare(true)),
    [prepare],
  );
  useEffect(
    () =>
      window.desktop?.onLeaveCancelled?.(() => {
        const previousEpoch = epoch.current;
        epoch.current += 1;
        focus.timeout(previousEpoch, epoch.current);
        const attempt = pending.current;
        if (attempt)
          void releasePauses(attempt).catch(() => {
            // The existing timeout notice keeps the failed attempt visible.
          });
        setSaving(false);
        setError('保存尚未完成，窗口已保留。请等待或重试保存后再次关闭。');
      }),
    [focus],
  );
  return { saving, error, prepare, retry: () => prepare() };
}
