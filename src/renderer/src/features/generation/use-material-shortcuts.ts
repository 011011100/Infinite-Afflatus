import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  canvasControls,
  canvasTextInputs,
} from '@/components/canvas/keyboard-boundary';
import { isMac } from '@/lib/platform';
import type { ShotHistoryActions } from '../../../../shared/generation/shot-history';
import type { Point } from '../../../../shared/generation/workspace';
import {
  moveShortcutDelta,
  type Shortcut,
  type Shortcuts,
  sameShortcut,
  shortcutAction,
} from '../../../../shared/interaction/shortcuts';

/** One scoped keyboard boundary keeps material edits out of the underlying video canvas. */
export function useMaterialShortcuts(
  page: RefObject<HTMLElement | null>,
  history: ShotHistoryActions | undefined,
  shortcuts: Shortcuts,
  disabled: boolean,
  reset: () => void,
  move: (delta: Readonly<Point>) => void,
  keyboardInactive = false,
) {
  const pointer = useRef<number | null>(null);
  const [heldShortcut, setHeldShortcut] = useState<Shortcut | null>(null);
  const heldMatches =
    !!heldShortcut &&
    !!shortcuts.locateLabels &&
    sameShortcut(heldShortcut, shortcuts.locateLabels);
  const latest = useRef({ history, disabled, reset, move, keyboardInactive });
  latest.current = { history, disabled, reset, move, keyboardInactive };
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
    if (disabled || keyboardInactive || !heldMatches) setHeldShortcut(null);
  }, [disabled, heldMatches, keyboardInactive]);
  useEffect(() => {
    const release = (event: PointerEvent) => {
      if (event.pointerId === pointer.current) pointer.current = null;
    };
    const blur = () => {
      pointer.current = null;
      setHeldShortcut(null);
    };
    const focus = (event: FocusEvent) => {
      if (
        !(event.target instanceof Node) ||
        !page.current?.contains(event.target) ||
        (event.target instanceof Element &&
          event.target.closest(canvasControls) &&
          !event.target.closest('.label-locator'))
      )
        setHeldShortcut(null);
    };
    const visibility = () => setHeldShortcut(null);
    const up = (event: KeyboardEvent) => {
      const shortcut = shortcuts.locateLabels;
      if (!shortcut) return;
      const key = event.key === ' ' ? 'Space' : event.key.toLowerCase();
      if (
        key === shortcut.key ||
        (shortcut.mod && !(isMac ? event.metaKey : event.ctrlKey)) ||
        (shortcut.shift && !event.shiftKey)
      )
        setHeldShortcut(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHeldShortcut(null);
      const root = page.current;
      if (
        !root ||
        !(event.target instanceof Node) ||
        !root.contains(event.target) ||
        !root.contains(document.activeElement) ||
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest(canvasTextInputs))
      )
        return;
      const action = shortcutAction(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          isComposing: event.isComposing,
          repeat: false,
        },
        shortcuts,
        isMac,
      );
      const delta = moveShortcutDelta(action);
      const control =
        event.target instanceof Element && event.target.closest(canvasControls);
      // Even an unbound, repeated or blocked arrow must not fall through to
      // React Flow's built-in transient movement. Enter/Tab selection stays native.
      const nativeArrow =
        /^Arrow(Left|Right|Up|Down)$/.test(event.key) &&
        event.target instanceof Element &&
        !!event.target.closest(
          '.react-flow__node, .react-flow__nodesselection-rect',
        );
      if (control && (delta || /^Arrow(Left|Right|Up|Down)$/.test(event.key)))
        return;
      const unavailable =
        event.repeat ||
        event.isComposing ||
        latest.current.keyboardInactive ||
        !!document.querySelector(
          'dialog[open], [role="dialog"], [role="menu"]',
        );
      if (action === 'locateLabels') {
        // The locator and node movement share one capture boundary. Never pass a
        // configured locator arrow down to React Flow's transient movement.
        if (control) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (
          !unavailable &&
          !latest.current.disabled &&
          pointer.current === null
        )
          setHeldShortcut(shortcuts.locateLabels);
        return;
      }
      if ((delta || nativeArrow) && !control) {
        // A custom undo/redo arrow is handled by the same boundary below.
        if (!unavailable && (action === 'undo' || action === 'redo')) {
          event.preventDefault();
          event.stopImmediatePropagation();
          actions.current(action);
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        const current = latest.current;
        if (
          !unavailable &&
          delta &&
          !current.disabled &&
          pointer.current === null
        )
          current.move(delta);
        return;
      }
      if (unavailable) return;
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
    window.addEventListener('focusin', focus);
    window.addEventListener('keydown', key, true);
    window.addEventListener('keyup', up, true);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('focusin', focus);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('keyup', up, true);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [page, shortcuts]);
  return {
    undo: () => perform('undo'),
    redo: () => perform('redo'),
    labelsHeld: !disabled && !keyboardInactive && heldMatches,
    onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => {
      pointer.current = event.pointerId;
      // A held locator must remain mounted while its destination button is
      // focused/clicked; other pointer gestures end the held overlay.
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('.label-locator')
      )
        setHeldShortcut(null);
      if (
        event.target instanceof Element &&
        !event.target.closest(`${canvasControls}, dialog, [role="dialog"]`)
      )
        page.current?.focus({ preventScroll: true });
    },
  };
}
