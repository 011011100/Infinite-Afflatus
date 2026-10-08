import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  captureFocus,
  type FocusSnapshot,
  restoreFocusAfterCommit,
} from '@/lib/focus-restoration';
import { acquireInert } from '@/lib/inert-lease';
import { instantMotion } from '@/lib/input-method';

function timing(element: HTMLElement, closing = false) {
  const style = getComputedStyle(element);
  return {
    duration:
      parseFloat(
        style.getPropertyValue(
          closing ? '--modal-close-dur' : '--modal-open-dur',
        ),
      ) || (closing ? 150 : 250),
    easing: style.getPropertyValue('--modal-ease').trim() || 'ease-out',
  };
}

/** A new view enters once; ordinary rerenders and direct manipulation stay instant. */
export function useContentMotion(
  ref: RefObject<HTMLElement | null>,
  view: unknown = null,
) {
  const animation = useRef<Animation | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A view identity change intentionally replays entry.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (!instantMotion())
      animation.current = element.animate(
        [
          { opacity: 0, transform: 'translateY(8px)' },
          { opacity: 1, transform: 'none' },
        ],
        timing(element),
      );
    return () => animation.current?.cancel();
  }, [ref, view]);
  return animation;
}

/** Keep the underlying canvas mounted until the outgoing page has disappeared. */
export function usePageMotion(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  beforeClose?: () => Promise<boolean>,
) {
  const animation = useContentMotion(ref);
  const callbacks = useRef({ onClose, beforeClose });
  callbacks.current = { onClose, beforeClose };
  const alive = useRef(false);
  const pending = useRef(false);
  const epoch = useRef(0);
  const releaseClose = useRef<(() => void) | null>(null);
  const [closing, setClosing] = useState(false);
  const [restore, setRestore] = useState<{
    epoch: number;
    focus: FocusSnapshot | null;
  } | null>(null);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current += 1;
      releaseClose.current?.();
      releaseClose.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (closing || !restore) return;
    return restoreFocusAfterCommit(restore.focus, {
      isCurrent: () =>
        alive.current && !pending.current && epoch.current === restore.epoch,
      fallback: ref.current,
    });
  }, [closing, restore, ref]);
  const requestClose = useCallback(async () => {
    const element = ref.current;
    if (!element || pending.current) return;
    pending.current = true;
    const currentEpoch = ++epoch.current;
    setClosing(true);
    // Block edits during the final save as well as the exit; stop audio immediately.
    const focus = captureFocus();
    const release = acquireInert(element);
    releaseClose.current = release;
    element
      .querySelectorAll<HTMLMediaElement>('video,audio')
      .forEach((media) => {
        media.pause();
      });
    let dismiss = false;
    try {
      if (
        callbacks.current.beforeClose &&
        !(await callbacks.current.beforeClose())
      )
        return;
      if (!alive.current) return;
      if (!instantMotion()) {
        // Closing during entry starts at the current pose, without jumping to fully open.
        const style = getComputedStyle(element);
        const start = { opacity: style.opacity, transform: style.transform };
        animation.current?.cancel();
        const exit = element.animate(
          [start, { opacity: 0, transform: 'translateY(8px)' }],
          { ...timing(element, true), fill: 'forwards' },
        );
        animation.current = exit;
        await exit.finished.catch(() => {});
      }
      if (alive.current) {
        dismiss = true;
        callbacks.current.onClose();
      }
    } finally {
      if (alive.current && !dismiss) {
        release();
        releaseClose.current = null;
        pending.current = false;
        setClosing(false);
        setRestore({ epoch: currentEpoch, focus });
      }
    }
  }, [ref, animation]);
  return { closing, requestClose };
}
