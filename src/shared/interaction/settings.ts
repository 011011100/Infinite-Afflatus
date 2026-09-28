import {
  SHORTCUT_ACTIONS,
  SHORTCUT_LABELS,
  type Shortcuts,
  sameShortcut,
  validateShortcut,
} from './shortcuts';

export interface InteractionSettings {
  version: 1;
  longPressSplit: boolean;
  shortcuts: Shortcuts;
}

export function defaultInteractionSettings(): InteractionSettings {
  return {
    version: 1,
    longPressSplit: true,
    shortcuts: {
      play: { key: 'Space', mod: false, shift: false, alt: false },
      split: { key: 'g', mod: true, shift: true, alt: false },
      undo: { key: 'z', mod: true, shift: false, alt: false },
      redo: { key: 'z', mod: true, shift: true, alt: false },
    },
  };
}

export function validateInteractionSettings(
  value: unknown,
): asserts value is InteractionSettings {
  if (!value || typeof value !== 'object') throw new Error('交互设置无效');
  const settings = value as InteractionSettings;
  if (
    settings.version !== 1 ||
    typeof settings.longPressSplit !== 'boolean' ||
    !settings.shortcuts ||
    typeof settings.shortcuts !== 'object'
  )
    throw new Error('交互设置格式或版本无效');
  for (const action of SHORTCUT_ACTIONS) {
    const binding = settings.shortcuts[action];
    if (binding === null) continue;
    validateShortcut(binding);
    const conflict = SHORTCUT_ACTIONS.find(
      (other) =>
        other !== action &&
        settings.shortcuts[other] &&
        sameShortcut(binding, settings.shortcuts[other]),
    );
    if (conflict)
      throw new Error(
        `「${SHORTCUT_LABELS[action]}」与「${SHORTCUT_LABELS[conflict]}」的快捷键重复`,
      );
  }
}
