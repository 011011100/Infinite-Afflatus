import type { InteractionSettings } from '../../src/shared/interaction/settings';
import type { Shortcut } from '../../src/shared/interaction/shortcuts';

// Independent contract, not derived from the current default or upgrade function.
// Historical settings and their expected manifests must remain untouched.
export const movementDefaults = {
  moveLeft: { key: 'arrowleft', mod: false, shift: false, alt: false },
  moveRight: { key: 'arrowright', mod: false, shift: false, alt: false },
  moveUp: { key: 'arrowup', mod: false, shift: false, alt: false },
  moveDown: { key: 'arrowdown', mod: false, shift: false, alt: false },
  moveLeftFast: { key: 'arrowleft', mod: false, shift: true, alt: false },
  moveRightFast: { key: 'arrowright', mod: false, shift: true, alt: false },
  moveUpFast: { key: 'arrowup', mod: false, shift: true, alt: false },
  moveDownFast: { key: 'arrowdown', mod: false, shift: true, alt: false },
} as const;

export function withMovementDefaults(
  settings: InteractionSettings,
): InteractionSettings {
  const next = structuredClone(settings);
  for (const [action, binding] of Object.entries(movementDefaults)) {
    if (Object.hasOwn(next.shortcuts, action)) continue;
    const conflict = Object.values(next.shortcuts).some(
      (other: Shortcut | null) =>
        other &&
        other.key === binding.key &&
        other.mod === binding.mod &&
        other.shift === binding.shift &&
        other.alt === binding.alt,
    );
    next.shortcuts[action as keyof typeof movementDefaults] = conflict
      ? null
      : { ...binding };
  }
  return withFindMaterialsDefault(next);
}

export function withFindMaterialsDefault(
  settings: InteractionSettings,
): InteractionSettings {
  const next = structuredClone(settings);
  if (Object.hasOwn(next.shortcuts, 'findMaterials')) return next;
  const binding = { key: 'k', mod: true, shift: false, alt: false };
  const conflict = Object.values(next.shortcuts).some(
    (other: Shortcut | null) =>
      other &&
      other.key === binding.key &&
      other.mod === binding.mod &&
      other.shift === binding.shift &&
      other.alt === binding.alt,
  );
  next.shortcuts.findMaterials = conflict ? null : binding;
  return next;
}
