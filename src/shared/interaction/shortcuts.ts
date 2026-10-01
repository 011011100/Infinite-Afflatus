export const SHORTCUT_ACTIONS = [
  'play',
  'split',
  'undo',
  'redo',
  'locateLabels',
] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];
export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  play: '播放选中卡片',
  split: '拆分选中片段',
  undo: '撤销',
  redo: '重做',
  locateLabels: '按住定位标签（素材画布）',
};
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
  if (!/^[a-z0-9]$/.test(key) && key !== 'Space') return null;
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
    shortcut.key === 'Space' ? '空格' : shortcut.key.toUpperCase(),
  ]
    .filter(Boolean)
    .join(isMac ? ' ' : ' + ');
}

export function validateShortcut(value: unknown): asserts value is Shortcut {
  if (!value || typeof value !== 'object') throw new Error('快捷键格式无效');
  const key = value as Shortcut;
  if (
    typeof key.key !== 'string' ||
    (!/^[a-z0-9]$/.test(key.key) && key.key !== 'Space') ||
    typeof key.mod !== 'boolean' ||
    typeof key.shift !== 'boolean' ||
    typeof key.alt !== 'boolean'
  )
    throw new Error('请使用支持的字母、数字或空格快捷键');
  // Keep native editing, window commands, IME switching and system shortcuts available.
  if (
    key.alt ||
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
