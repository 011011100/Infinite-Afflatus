import { useCallback, useEffect, useRef, useState } from 'react';
import { flushPendingChanges } from './pending-saves';

type SaveAttempt = {
  epoch: number;
  keepFrozen: boolean;
  promise: Promise<boolean>;
};

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
    let successful = false;
    const attempt: SaveAttempt = {
      epoch: currentEpoch,
      keepFrozen: nativeClose,
      promise: Promise.resolve()
        .then(async () => {
          // Long reads/copies share the write gate. Release them before waiting
          // for drafts, including an older save pass already queued behind them.
          await Promise.all([
            window.desktop?.cancelProjectHealth?.(),
            window.desktop?.cancelProjectPackage?.(),
          ]);
          // A timed-out pass may already have scanned an editor that the user has
          // since changed. Drain it, then scan every editor again while frozen.
          await previous?.promise;
          if (epoch.current !== currentEpoch) return false;
          const saved = await flushPendingChanges();
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
        .finally(() => {
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
        setSaving(false);
        setError('保存尚未完成，窗口已保留。请等待或重试保存后再次关闭。');
      }),
    [],
  );
  return { saving, error, prepare, retry: () => prepare() };
}
