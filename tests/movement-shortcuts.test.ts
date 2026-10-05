import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InteractionSettingsStore } from '../src/main/settings/interaction-settings';
import { AppStore } from '../src/main/storage/app-store';
import {
  defaultInteractionSettings,
  upgradeInteractionSettings,
  validateInteractionSettings,
} from '../src/shared/interaction/settings';
import {
  formatShortcut,
  type KeyInput,
  MOVE_SHORTCUT_ACTIONS,
  moveShortcutDelta,
  SHORTCUT_ACTIONS,
  type Shortcut,
  shortcutAction,
  shortcutFromKey,
} from '../src/shared/interaction/shortcuts';

const event = (key: string, rest: Partial<KeyInput> = {}): KeyInput => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...rest,
});
const binding = (key: string, shift = false): Shortcut => ({
  key,
  mod: false,
  shift,
  alt: false,
});
const legacy = () => ({
  version: 1,
  longPressSplit: false,
  shortcuts: {
    play: binding('p'),
    split: { ...binding('g', true), mod: true },
    undo: { ...binding('u'), mod: true },
    redo: null,
    locateLabels: null,
  },
});

test('all eight movement defaults match exact arrow modifiers on both systems and retain 5/20 deltas', () => {
  const settings = defaultInteractionSettings();
  validateInteractionSettings(settings);
  const cases = [
    ['Left', -1, 0, '←'],
    ['Right', 1, 0, '→'],
    ['Up', 0, -1, '↑'],
    ['Down', 0, 1, '↓'],
  ] as const;
  for (const mac of [false, true])
    for (const [direction, x, y, label] of cases)
      for (const fast of [false, true]) {
        const action = `move${direction}${fast ? 'Fast' : ''}` as const;
        const input = event(`Arrow${direction}`, { shiftKey: fast });
        assert.equal(shortcutAction(input, settings.shortcuts, mac), action);
        assert.deepEqual(moveShortcutDelta(action), {
          x: x * (fast ? 20 : 5) || 0,
          y: y * (fast ? 20 : 5) || 0,
        });
        assert.equal(
          formatShortcut(shortcutFromKey(input, mac), mac),
          fast ? `${mac ? '⇧ ' : 'Shift + '}${label}` : label,
        );
        assert.equal(
          shortcutAction({ ...input, repeat: true }, settings.shortcuts, mac),
          null,
        );
        assert.equal(
          shortcutAction(
            { ...input, isComposing: true },
            settings.shortcuts,
            mac,
          ),
          null,
        );
        assert.equal(
          shortcutAction({ ...input, altKey: true }, settings.shortcuts, mac),
          null,
        );
        assert.equal(
          shortcutAction(
            { ...input, ctrlKey: true, metaKey: true },
            settings.shortcuts,
            mac,
          ),
          null,
        );
      }
  assert.equal(MOVE_SHORTCUT_ACTIONS.length, 8);
  assert.equal(moveShortcutDelta(null), null);
  for (const action of [
    'play',
    'split',
    'undo',
    'redo',
    'locateLabels',
  ] as const)
    assert.equal(moveShortcutDelta(action), null);
  assert.ok(Object.isFrozen(moveShortcutDelta('moveRight')));
});

test('movement bindings can be changed or explicitly disabled without an implicit Shift alias', () => {
  const settings = defaultInteractionSettings();
  settings.shortcuts.moveLeft = binding('j');
  settings.shortcuts.moveLeftFast = null;
  settings.shortcuts.redo = binding('j', true);
  validateInteractionSettings(settings);
  for (const mac of [true, false]) {
    assert.equal(
      shortcutAction(event('j'), settings.shortcuts, mac),
      'moveLeft',
    );
    assert.equal(
      shortcutAction(event('J', { shiftKey: true }), settings.shortcuts, mac),
      'redo',
    );
    assert.equal(
      shortcutAction(event('ArrowLeft'), settings.shortcuts, mac),
      null,
    );
    assert.equal(
      shortcutAction(
        event('ArrowLeft', { shiftKey: true }),
        settings.shortcuts,
        mac,
      ),
      null,
    );
  }
});

test('reserved navigation, unsupported keys and movement/other-action conflicts are rejected', () => {
  for (const arrow of ['arrowleft', 'arrowright', 'arrowup', 'arrowdown']) {
    for (const change of [
      { mod: true },
      { alt: true },
      { mod: true, shift: true },
    ]) {
      const settings = defaultInteractionSettings();
      settings.shortcuts.moveLeft = { ...binding(arrow), ...change };
      assert.throws(
        () => validateInteractionSettings(settings),
        /系统或文本编辑/,
      );
    }
  }
  for (const key of [
    'ArrowLeft',
    'Home',
    'End',
    'Tab',
    'Escape',
    'F1',
    'arrowtop',
  ]) {
    const settings = defaultInteractionSettings();
    settings.shortcuts.moveLeft = binding(key);
    assert.throws(
      () => validateInteractionSettings(settings),
      /字母、数字、空格或方向键/,
    );
  }
  for (const action of SHORTCUT_ACTIONS.filter(
    (action) => action !== 'moveLeft',
  )) {
    const settings = defaultInteractionSettings();
    settings.shortcuts[action] = settings.shortcuts.moveLeft;
    assert.throws(() => validateInteractionSettings(settings), /重复/);
  }
});

test('read upgrade preserves all five historical bindings and nulls without mutating input', () => {
  const old = legacy();
  const original = structuredClone(old);
  const upgraded = upgradeInteractionSettings(old);
  assert.deepEqual(old, original);
  for (const [action, value] of Object.entries(original.shortcuts))
    assert.deepEqual(
      upgraded.shortcuts[action as keyof typeof upgraded.shortcuts],
      value,
    );
  assert.equal(upgraded.version, 1);
  assert.equal(upgraded.longPressSplit, false);
  assert.deepEqual(
    Object.fromEntries(
      MOVE_SHORTCUT_ACTIONS.map((action) => [
        action,
        upgraded.shortcuts[action],
      ]),
    ),
    {
      moveLeft: binding('arrowleft'),
      moveRight: binding('arrowright'),
      moveUp: binding('arrowup'),
      moveDown: binding('arrowdown'),
      moveLeftFast: binding('arrowleft', true),
      moveRightFast: binding('arrowright', true),
      moveUpFast: binding('arrowup', true),
      moveDownFast: binding('arrowdown', true),
    },
  );
  assert.deepEqual(upgradeInteractionSettings(upgraded), upgraded);
});

test('missing movement defaults yield to existing bindings while explicit null and custom movement remain unchanged', () => {
  const old = legacy();
  const partial = {
    ...old,
    shortcuts: {
      ...old.shortcuts,
      play: binding('arrowleft'),
      split: binding('arrowdown', true),
      moveRight: null,
      moveUp: binding('w'),
    },
  };
  const before = structuredClone(partial);
  const upgraded = upgradeInteractionSettings(partial);
  assert.equal(upgraded.shortcuts.moveLeft, null);
  assert.equal(upgraded.shortcuts.moveDownFast, null);
  assert.equal(upgraded.shortcuts.moveRight, null);
  assert.deepEqual(upgraded.shortcuts.moveUp, binding('w'));
  assert.deepEqual(upgraded.shortcuts.play, binding('arrowleft'));
  assert.deepEqual(upgraded.shortcuts.split, binding('arrowdown', true));
  assert.deepEqual(partial, before);
  // This is a partial current-format unit input, not an alleged old-writer fixture:
  // the pinned historical version could not save arrow bindings.
});

test('upgrade does not silently repair missing old actions, invalid supplied new actions or unknown versions', () => {
  const { undo: _, ...withoutUndo } = legacy().shortcuts;
  for (const value of [
    { ...legacy(), version: 2 },
    { ...legacy(), shortcuts: withoutUndo },
    { ...legacy(), shortcuts: { ...legacy().shortcuts, moveLeft: undefined } },
    { ...legacy(), shortcuts: { ...legacy().shortcuts, moveLeft: 5 } },
    { ...legacy(), shortcuts: 'invalid' },
  ]) {
    const before = structuredClone(value);
    assert.throws(() => upgradeInteractionSettings(value));
    assert.deepEqual(value, before);
  }
});

test('settings reads preserve raw legacy storage; rejected saves do not overwrite it and explicit defaults restore all actions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'afflatus-move-settings-'));
  const file = join(directory, 'app.sqlite');
  const store = new AppStore(file, join(directory, 'projects'));
  try {
    const old = legacy();
    store.set('interactions', old);
    const before = await readFile(file);
    const service = new InteractionSettingsStore(store);
    const upgraded = service.get();
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(store.get('interactions'), old);
    assert.throws(
      () =>
        service.save({
          ...upgraded,
          shortcuts: {
            ...upgraded.shortcuts,
            moveRight: upgraded.shortcuts.moveLeft,
          },
        }),
      /重复/,
    );
    assert.deepEqual(await readFile(file), before);
    upgraded.shortcuts.moveLeft = binding('a');
    upgraded.shortcuts.moveLeftFast = null;
    assert.deepEqual(service.save(upgraded), upgraded);
    assert.deepEqual(store.get('interactions'), upgraded);
    const restored = service.save(defaultInteractionSettings());
    assert.deepEqual(restored, defaultInteractionSettings());
    assert.equal(
      formatShortcut(restored.shortcuts.moveLeftFast, false),
      'Shift + ←',
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
