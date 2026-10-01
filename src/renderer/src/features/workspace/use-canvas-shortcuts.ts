import { useEffect } from 'react';
import { isMac } from '@/lib/platform';
import {
  type ShortcutAction,
  type Shortcuts,
  shortcutAction,
} from '../../../../shared/interaction/shortcuts';

export function useCanvasShortcuts({
  shortcuts,
  disabled,
  actions,
  cancel,
}: {
  shortcuts: Shortcuts;
  disabled: boolean;
  actions: Partial<Record<ShortcutAction, (() => void) | null>>;
  cancel: () => void;
}) {
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        document.querySelector('dialog[open]')
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
        )
      )
        return;
      if (event.key === 'Escape') {
        cancel();
        event.preventDefault();
        return;
      }
      if (disabled) return;
      const name = shortcutAction(event, shortcuts, isMac);
      const action = name && actions[name];
      if (!action) return;
      // Native button activation keeps working when focus is on a toolbar control.
      if (
        event.key === ' ' &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        event.target instanceof Element &&
        event.target.closest('button') &&
        !event.target.closest('[data-video-thumbnail]')
      )
        return;
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [shortcuts, disabled, actions, cancel]);
}
