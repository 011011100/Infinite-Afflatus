import type { KeyboardEvent } from 'react';

export const canvasTextInputs =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
export const canvasControls = `${canvasTextInputs}, button, a, video, audio, [role="button"], [role="slider"], [role="spinbutton"], [role="combobox"], [role="menuitem"], .react-flow__resize-control`;

/** Let a control handle its own keys before they can reach React Flow's node handler. */
export function stopCanvasControlKeys(event: KeyboardEvent<HTMLElement>) {
  if (event.target instanceof Element && event.target.closest(canvasControls))
    event.stopPropagation();
}
