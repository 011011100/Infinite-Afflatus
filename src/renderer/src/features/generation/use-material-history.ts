import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
} from 'react';
import { isMac } from '@/lib/platform';
import type { ShotHistoryActions } from '../../../../shared/generation/shot-history';
import {
  type Shortcuts,
  shortcutAction,
} from '../../../../shared/interaction/shortcuts';

const editing =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';

/** Scoped capture prevents material undo from falling through to the underlying video canvas. */
export function useMaterialHistory(
  page: RefObject<HTMLElement | null>,
  history: ShotHistoryActions | undefined,
  shortcuts: Shortcuts,
  disabled: boolean,
  reset: () => void,
) {
  const pointer = useRef<number | null>(null);
  const latest = useRef({ history, disabled, reset });
  latest.current = { history, disabled, reset };
  const perform = (direction: 'undo' | 'redo') => {
    const current = latest.current;
    if (
      current.disabled ||
      pointer.current !== null ||
      !current.history?.[direction === 'undo' ? 'canUndo' : 'canRedo']
    )
      return;
    current.reset();
    current.history[direction]();
  };
  const actions = useRef(perform);
  actions.current = perform;
  useEffect(() => {
    const release = (event: PointerEvent) => {
      if (event.pointerId === pointer.current) pointer.current = null;
    };
    const blur = () => {
      pointer.current = null;
    };
    const key = (event: KeyboardEvent) => {
      const root = page.current;
      if (
        !root ||
        !(event.target instanceof Node) ||
        !root.contains(event.target) ||
        !root.contains(document.activeElement) ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        document.querySelector(
          'dialog[open], [role="dialog"], [role="menu"]',
        ) ||
        (event.target instanceof Element && event.target.closest(editing))
      )
        return;
      const action = shortcutAction(event, shortcuts, isMac);
      if (action !== 'undo' && action !== 'redo') return;
      if (
        event.key === ' ' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.target instanceof Element &&
        event.target.closest('button, [role="button"]')
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      actions.current(action);
    };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('blur', blur);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('keydown', key, true);
    };
  }, [page, shortcuts]);
  return {
    undo: () => perform('undo'),
    redo: () => perform('redo'),
    onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => {
      pointer.current = event.pointerId;
      if (
        event.target instanceof Element &&
        !event.target.closest(
          `${editing}, button, [role="button"], dialog, [role="dialog"]`,
        )
      )
        page.current?.focus({ preventScroll: true });
    },
  };
}
