import {
  MOVE_SHORTCUT_ACTIONS,
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
      locateLabels: { key: 'l', mod: false, shift: false, alt: false },
      findMaterials: { key: 'k', mod: true, shift: false, alt: false },
      play: { key: 'Space', mod: false, shift: false, alt: false },
      split: { key: 'g', mod: true, shift: true, alt: false },
      undo: { key: 'z', mod: true, shift: false, alt: false },
      redo: { key: 'z', mod: true, shift: true, alt: false },
      moveLeft: { key: 'arrowleft', mod: false, shift: false, alt: false },
      moveRight: { key: 'arrowright', mod: false, shift: false, alt: false },
      moveUp: { key: 'arrowup', mod: false, shift: false, alt: false },
      moveDown: { key: 'arrowdown', mod: false, shift: false, alt: false },
      moveLeftFast: { key: 'arrowleft', mod: false, shift: true, alt: false },
      moveRightFast: { key: 'arrowright', mod: false, shift: true, alt: false },
      moveUpFast: { key: 'arrowup', mod: false, shift: true, alt: false },
      moveDownFast: { key: 'arrowdown', mod: false, shift: true, alt: false },
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

/** Add missing actions without rewriting older custom bindings or explicit nulls. */
export function upgradeInteractionSettings(
  value: unknown,
): InteractionSettings {
  const next = structuredClone(value) as InteractionSettings;
  if (
    next?.version === 1 &&
    next.shortcuts &&
    typeof next.shortcuts === 'object'
  ) {
    const defaults = defaultInteractionSettings().shortcuts;
    for (const action of [
      'locateLabels',
      ...MOVE_SHORTCUT_ACTIONS,
      'findMaterials',
    ] as const) {
      if (Object.hasOwn(next.shortcuts, action)) continue;
      const binding = defaults[action];
      const conflict =
        binding &&
        Object.values(next.shortcuts).some(
          (other) => other && sameShortcut(binding, other),
        );
      next.shortcuts[action] = conflict ? null : binding;
    }
  }
  validateInteractionSettings(next);
  return next;
}
