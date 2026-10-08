import { type RefObject, useLayoutEffect, useRef } from 'react';
import {
  captureFocus,
  type FocusSnapshot,
  restoreFocusAfterCommit,
} from '@/lib/focus-restoration';
import { acquireInert } from '@/lib/inert-lease';

/** A full-window editor owns the background lock until it actually unmounts. */
export function usePageFocus(ref: RefObject<HTMLElement | null>): void {
  const opener = useRef<{ focus: FocusSnapshot | null } | null>(null);
  const epoch = useRef(0);
  const cancelRestore = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const page = ref.current;
    if (!page) return;
    const current = ++epoch.current;
    cancelRestore.current?.();
    // Preserve the original opener across StrictMode's setup/cleanup replay.
    opener.current ??= { focus: captureFocus() };
    const root = document.getElementById('root');
    const release = root ? acquireInert(root) : () => {};
    if (!document.querySelector('[data-save-before-leave]'))
      page.focus({ preventScroll: true });
    return () => {
      release();
      cancelRestore.current = restoreFocusAfterCommit(
        opener.current?.focus ?? null,
        {
          isCurrent: () => epoch.current === current && !page.isConnected,
        },
      );
    };
  }, [ref]);
}
