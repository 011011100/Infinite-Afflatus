import { getModalHost } from './modal-hosts';

type TextSelection = {
  value: string;
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
};

export type FocusSnapshot = {
  target: HTMLElement;
  scope: HTMLElement | null;
  selection: TextSelection | null;
};

export function captureFocus(
  element: HTMLElement | null = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null,
): FocusSnapshot | null {
  if (!element || element === element.ownerDocument.body) return null;
  const text =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
      ? element
      : null;
  return {
    target: element,
    scope: element.closest<HTMLElement>('[data-focus-scope]'),
    selection:
      text && text.selectionStart !== null && text.selectionEnd !== null
        ? {
            value: text.value,
            start: text.selectionStart,
            end: text.selectionEnd,
            direction: text.selectionDirection ?? 'none',
          }
        : null,
  };
}

function available(element: HTMLElement): boolean {
  const inert = element.closest('[inert]');
  const modal = element.closest('dialog:modal');
  // Native modal dialogs escape ancestor inertness, but not their own lock.
  const blocked = inert && !(modal && inert !== modal && inert.contains(modal));
  return (
    element.isConnected &&
    !element.matches(':disabled') &&
    !blocked &&
    !element.closest('[hidden], [aria-hidden="true"]') &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== 'hidden'
  );
}

/** Run after React restores disabled controls; never take focus from new work. */
export function restoreFocusAfterCommit(
  snapshot: FocusSnapshot | null,
  options: {
    isCurrent: () => boolean;
    allowedFocus?: (element: Element | null) => boolean;
    fallback?: HTMLElement | null;
  },
): () => void {
  if (!snapshot) return () => {};
  const doc = snapshot.target.ownerDocument;
  const view = doc.defaultView;
  if (!view) return () => {};
  const frame = view.requestAnimationFrame(() => {
    if (!options.isCurrent()) return;
    const active = doc.activeElement;
    // The user may have already resumed editing and changed the selection.
    if (active === snapshot.target) return;
    if (
      active &&
      active !== doc.body &&
      active !== doc.documentElement &&
      !options.allowedFocus?.(active)
    )
      return;
    const target = available(snapshot.target)
      ? snapshot.target
      : (options.fallback ?? snapshot.scope);
    if (!target || !available(target)) return;
    // Follow showModal order, not DOM order: an older dialog may remain open
    // underneath the one the user is editing. The save guard sits above both.
    const modal =
      doc.querySelector<HTMLElement>('dialog[open][data-save-before-leave]') ??
      getModalHost()?.dialog;
    if (modal?.isConnected && available(modal) && !modal.contains(target))
      return;
    for (const surface of doc.querySelectorAll<HTMLElement>(
      '[aria-modal="true"]',
    )) {
      if (
        !(surface instanceof HTMLDialogElement) &&
        available(surface) &&
        !surface.contains(target)
      )
        return;
    }
    target.focus({ preventScroll: true });
    const selection = snapshot.selection;
    if (
      doc.activeElement === target &&
      target === snapshot.target &&
      selection &&
      (target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement) &&
      target.value === selection.value
    )
      target.setSelectionRange(
        selection.start,
        selection.end,
        selection.direction,
      );
  });
  return () => view.cancelAnimationFrame(frame);
}
