import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  captureFocus,
  type FocusSnapshot,
  restoreFocusAfterCommit,
} from '@/lib/focus-restoration';

const ownedFocus = '[data-save-before-leave], [data-save-retry]';
type FocusAttempt = {
  epoch: number;
  snapshot: FocusSnapshot | null;
  restorePending: boolean;
};

/** Keep one editing destination while the save overlay and retry button replace focus. */
export function useSaveFocus(saving: boolean, epoch: RefObject<number>) {
  const recent = useRef<FocusSnapshot | null>(null);
  const attempt = useRef<FocusAttempt | null>(null);
  const cancelFrame = useRef<(() => void) | null>(null);
  const [restoreRequest, setRestoreRequest] = useState<{
    attempt: FocusAttempt;
  } | null>(null);

  const cancelScheduled = useCallback(() => {
    cancelFrame.current?.();
    cancelFrame.current = null;
  }, []);

  useLayoutEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest(ownedFocus))
        return;
      // focusout supplies the original control even when activeElement is
      // already body. Capture its final caret, including edits since focusin.
      const snapshot = captureFocus(target);
      if (snapshot) {
        recent.current = snapshot;
        if (event.type === 'focusin' && attempt.current?.restorePending) {
          attempt.current.restorePending = false;
          cancelScheduled();
        }
      }
    };
    window.addEventListener('focusin', remember, true);
    window.addEventListener('focusout', remember, true);
    return () => {
      window.removeEventListener('focusin', remember, true);
      window.removeEventListener('focusout', remember, true);
      cancelScheduled();
      attempt.current = null;
      recent.current = null;
    };
  }, [cancelScheduled]);

  const begin = useCallback(
    (currentEpoch: number) => {
      cancelScheduled();
      const target = document.activeElement;
      const neutral =
        !target ||
        target === document.body ||
        target === document.documentElement;
      const frozenOrigin =
        neutral &&
        recent.current?.scope?.isConnected &&
        recent.current.scope.closest('[inert]');
      // A second immediate save can begin after the first unlocks, but before
      // its restoration frame. Carry that unconsumed origin, not arbitrary
      // historic focus after an ordinary click on empty space.
      const waitingOrigin =
        neutral && attempt.current?.restorePending
          ? attempt.current.snapshot
          : null;
      const snapshot =
        (target instanceof HTMLElement && target.closest(ownedFocus)) ||
        frozenOrigin
          ? recent.current
          : neutral
            ? waitingOrigin
            : captureFocus();
      if (snapshot) recent.current = snapshot;
      attempt.current = {
        epoch: currentEpoch,
        snapshot,
        restorePending: false,
      };
    },
    [cancelScheduled],
  );

  const restore = useCallback(
    (currentEpoch: number) => {
      const current = attempt.current;
      if (
        !current ||
        current.epoch !== currentEpoch ||
        epoch.current !== currentEpoch
      )
        return;
      // Even an immediately rejected save can blur before React batches
      // saving=true/false into one commit. This request still gets a layout pass.
      current.restorePending = true;
      setRestoreRequest({ attempt: current });
    },
    [epoch],
  );

  const timeout = useCallback(
    (previousEpoch: number, nextEpoch: number) => {
      cancelScheduled();
      const current = attempt.current;
      if (
        !current ||
        current.epoch !== previousEpoch ||
        epoch.current !== nextEpoch
      )
        return;
      // The timeout owns the unlock. A late completion retains its old epoch
      // and cannot schedule another restoration or displace a newer attempt.
      current.epoch = nextEpoch;
      current.restorePending = true;
      setRestoreRequest({ attempt: current });
    },
    [cancelScheduled, epoch],
  );

  useLayoutEffect(() => {
    if (saving) return;
    const current = restoreRequest?.attempt;
    if (!current || attempt.current !== current) return;
    cancelScheduled();
    const cancel = restoreFocusAfterCommit(current.snapshot, {
      isCurrent: () => {
        const valid =
          attempt.current === current &&
          epoch.current === current.epoch &&
          current.restorePending;
        current.restorePending = false;
        return valid;
      },
      allowedFocus: (element) => !!element?.closest('[data-save-before-leave]'),
      fallback: current.snapshot?.scope ?? null,
    });
    cancelFrame.current = cancel;
    return () => {
      cancel();
      if (cancelFrame.current === cancel) cancelFrame.current = null;
    };
  }, [saving, restoreRequest, epoch, cancelScheduled]);

  return useMemo(
    () => ({ begin, restore, timeout }),
    [begin, restore, timeout],
  );
}
