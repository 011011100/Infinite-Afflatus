export const MOVE_SHORTCUT_ACTIONS = [
  'moveLeft',
  'moveRight',
  'moveUp',
  'moveDown',
  'moveLeftFast',
  'moveRightFast',
  'moveUpFast',
  'moveDownFast',
] as const;
export type MoveShortcutAction = (typeof MOVE_SHORTCUT_ACTIONS)[number];

export const SHORTCUT_ACTIONS = [
  'play',
  'split',
  'undo',
  'redo',
  'locateLabels',
  'findMaterials',
  ...MOVE_SHORTCUT_ACTIONS,
] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];
export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  play: '播放选中卡片',
  split: '拆分选中片段',
  undo: '撤销',
  redo: '重做',
  locateLabels: '按住定位标签（素材画布）',
  findMaterials: '查找镜头素材（素材画布）',
  moveLeft: '向左移动（素材画布）',
  moveRight: '向右移动（素材画布）',
  moveUp: '向上移动（素材画布）',
  moveDown: '向下移动（素材画布）',
  moveLeftFast: '快速向左移动（素材画布）',
  moveRightFast: '快速向右移动（素材画布）',
  moveUpFast: '快速向上移动（素材画布）',
  moveDownFast: '快速向下移动（素材画布）',
};

const MOVE_DELTAS: Record<
  MoveShortcutAction,
  Readonly<{ x: number; y: number }>
> = {
  moveLeft: Object.freeze({ x: -5, y: 0 }),
  moveRight: Object.freeze({ x: 5, y: 0 }),
  moveUp: Object.freeze({ x: 0, y: -5 }),
  moveDown: Object.freeze({ x: 0, y: 5 }),
  moveLeftFast: Object.freeze({ x: -20, y: 0 }),
  moveRightFast: Object.freeze({ x: 20, y: 0 }),
  moveUpFast: Object.freeze({ x: 0, y: -20 }),
  moveDownFast: Object.freeze({ x: 0, y: 20 }),
};

export function moveShortcutDelta(
  action: ShortcutAction | null,
): Readonly<{ x: number; y: number }> | null {
  return action && Object.hasOwn(MOVE_DELTAS, action)
    ? MOVE_DELTAS[action as MoveShortcutAction]
    : null;
}

const ARROW_LABELS: Record<string, string> = {
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
};
const isArrowKey = (key: string) => Object.hasOwn(ARROW_LABELS, key);
const supportedKey = (key: string) =>
  /^[a-z0-9]$/.test(key) || key === 'Space' || isArrowKey(key);
export interface Shortcut {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}
export type Shortcuts = Record<ShortcutAction, Shortcut | null>;
export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}

export function shortcutFromKey(
  event: KeyInput,
  isMac: boolean,
): Shortcut | null {
  if (
    event.repeat ||
    event.isComposing ||
    (isMac ? event.ctrlKey : event.metaKey)
  )
    return null;
  const key = event.key === ' ' ? 'Space' : event.key.toLowerCase();
  if (!supportedKey(key)) return null;
  return {
    key,
    mod: isMac ? event.metaKey : event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
  };
}

export function sameShortcut(a: Shortcut, b: Shortcut): boolean {
  return (
    a.key === b.key && a.mod === b.mod && a.shift === b.shift && a.alt === b.alt
  );
}

export function shortcutAction(
  event: KeyInput,
  shortcuts: Shortcuts,
  isMac: boolean,
): ShortcutAction | null {
  const pressed = shortcutFromKey(event, isMac);
  if (!pressed) return null;
  return (
    SHORTCUT_ACTIONS.find((action) => {
      const binding = shortcuts[action];
      return binding && sameShortcut(binding, pressed);
    }) ?? null
  );
}

export function formatShortcut(
  shortcut: Shortcut | null,
  isMac: boolean,
): string {
  if (!shortcut) return '未设置';
  return [
    shortcut.mod ? (isMac ? '⌘' : 'Ctrl') : '',
    shortcut.alt ? (isMac ? '⌥' : 'Alt') : '',
    shortcut.shift ? (isMac ? '⇧' : 'Shift') : '',
    shortcut.key === 'Space'
      ? '空格'
      : (ARROW_LABELS[shortcut.key] ?? shortcut.key.toUpperCase()),
  ]
    .filter(Boolean)
    .join(isMac ? ' ' : ' + ');
}

export function validateShortcut(value: unknown): asserts value is Shortcut {
  if (!value || typeof value !== 'object') throw new Error('快捷键格式无效');
  const key = value as Shortcut;
  if (
    typeof key.key !== 'string' ||
    !supportedKey(key.key) ||
    typeof key.mod !== 'boolean' ||
    typeof key.shift !== 'boolean' ||
    typeof key.alt !== 'boolean'
  )
    throw new Error('请使用支持的字母、数字、空格或方向键');
  // Keep native editing, window commands, IME switching and system shortcuts available.
  if (
    key.alt ||
    (key.mod && isArrowKey(key.key)) ||
    (key.mod &&
      [
        'a',
        'c',
        'v',
        'x',
        'q',
        'w',
        'r',
        'h',
        'm',
        'n',
        'o',
        'p',
        's',
        'f',
        'Space',
        ...'0123456789',
      ].includes(key.key))
  )
    throw new Error('该组合键留给系统或文本编辑，请换一个快捷键');
}
