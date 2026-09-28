import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { InteractionSettingsStore } from '../src/main/settings/interaction-settings';
import { AppStore } from '../src/main/storage/app-store';
import { LONG_PRESS_MS, LongPress } from '../src/shared/interaction/long-press';
import {
  defaultInteractionSettings,
  validateInteractionSettings,
} from '../src/shared/interaction/settings';
import {
  formatShortcut,
  type KeyInput,
  shortcutAction,
  shortcutFromKey,
} from '../src/shared/interaction/shortcuts';

const key = (key: string, overrides: Partial<KeyInput> = {}): KeyInput => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

test('configured shortcuts match exact modifiers on macOS and Windows; old bindings stop working', () => {
  const settings = defaultInteractionSettings();
  assert.equal(shortcutAction(key(' '), settings.shortcuts, true), 'play');
  assert.equal(
    shortcutAction(
      key('G', { metaKey: true, shiftKey: true }),
      settings.shortcuts,
      true,
    ),
    'split',
  );
  assert.equal(
    shortcutAction(
      key('g', { ctrlKey: true, shiftKey: true }),
      settings.shortcuts,
      false,
    ),
    'split',
  );
  assert.equal(
    shortcutAction(
      key('g', { ctrlKey: true, shiftKey: true }),
      settings.shortcuts,
      true,
    ),
    null,
  );
  assert.equal(
    shortcutAction(key('g', { metaKey: true }), settings.shortcuts, true),
    null,
  );
  assert.equal(
    shortcutAction(key('z', { metaKey: true }), settings.shortcuts, true),
    'undo',
  );
  assert.equal(
    shortcutAction(
      key('Z', { metaKey: true, shiftKey: true }),
      settings.shortcuts,
      true,
    ),
    'redo',
  );
  settings.shortcuts.split = { key: 'd', mod: false, shift: false, alt: false };
  assert.equal(
    shortcutAction(
      key('g', { metaKey: true, shiftKey: true }),
      settings.shortcuts,
      true,
    ),
    null,
  );
  assert.equal(shortcutAction(key('d'), settings.shortcuts, true), 'split');
  settings.shortcuts.split = null;
  assert.equal(shortcutAction(key('d'), settings.shortcuts, true), null);
});

test('key repeat, IME composition, unsupported keys and extra modifiers cannot trigger commands', () => {
  const settings = defaultInteractionSettings();
  for (const event of [
    key(' ', { repeat: true }),
    key(' ', { isComposing: true }),
    key('Process'),
    key('Escape'),
    key(' ', { altKey: true }),
    key('z', { metaKey: true, ctrlKey: true }),
  ]) {
    assert.equal(shortcutAction(event, settings.shortcuts, true), null);
  }
  const recorded = shortcutFromKey(
    key('G', { metaKey: true, shiftKey: true }),
    true,
  );
  assert.deepEqual(recorded, settings.shortcuts.split);
  assert.equal(formatShortcut(recorded, true), '⌘ ⇧ G');
  assert.equal(formatShortcut(recorded, false), 'Ctrl + Shift + G');
});

test('preferences reject conflicts, reserved commands and malformed IPC payloads', () => {
  const defaults = defaultInteractionSettings();
  validateInteractionSettings(defaults);
  assert.throws(
    () =>
      validateInteractionSettings({
        ...defaults,
        shortcuts: { ...defaults.shortcuts, split: defaults.shortcuts.play },
      }),
    /重复/,
  );
  for (const binding of [
    { key: 'q', mod: true, shift: false, alt: false },
    { key: 'Tab', mod: false, shift: false, alt: false },
    { key: 'd', mod: false, shift: false, alt: true },
    { key: 'd', mod: 'yes', shift: false, alt: false },
  ]) {
    assert.throws(() =>
      validateInteractionSettings({
        ...defaults,
        shortcuts: { ...defaults.shortcuts, split: binding },
      }),
    );
  }
  for (const value of [
    null,
    {},
    { ...defaults, version: 2 },
    { ...defaults, shortcuts: {} },
    { ...defaults, longPressSplit: 'yes' },
  ]) {
    assert.throws(() => validateInteractionSettings(value));
  }
});

test('long press requires release after the threshold and fires only once; clicks and double-clicks never split', () => {
  const press = new LongPress();
  press.start(1, 0, 0, 0);
  assert.equal(press.release(1, LONG_PRESS_MS - 1), false);
  press.start(1, 0, 0, 800);
  assert.equal(press.release(1, 900), false);
  press.start(1, 0, 0, 1000);
  assert.equal(press.release(1, 1100), false);
  press.start(1, 0, 0, 2000);
  assert.equal(press.move(1, 3, 4), true);
  assert.equal(press.release(1, 2000 + LONG_PRESS_MS), true);
  assert.equal(press.release(1, 5000), false);
});

test('dragging away and back, cancellation and a different pointer cannot complete a long press', () => {
  const press = new LongPress();
  press.start(1, 100, 100, 0);
  assert.equal(press.move(1, 106, 100), false);
  assert.equal(press.move(1, 100, 100), false);
  assert.equal(press.release(1, 1000), false);
  press.start(1, 0, 0, 0);
  press.cancel();
  assert.equal(press.release(1, 1000), false);
  press.start(1, 0, 0, 0);
  assert.equal(press.release(2, 1000), false);
  assert.equal(press.release(1, 1000), true);
});

test('settings survive database reopen and a project-root switch; rejected writes leave saved preferences intact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'afflatus-preferences-'));
  const file = join(dir, 'app.sqlite');
  let store = new AppStore(file, '/initial-project-root');
  try {
    let preferences = new InteractionSettingsStore(store);
    assert.deepEqual(preferences.get(), defaultInteractionSettings());
    assert.equal(store.get('interactions'), null);
    const customized = {
      ...defaultInteractionSettings(),
      longPressSplit: false,
    };
    customized.shortcuts.split = {
      key: 'd',
      mod: false,
      shift: false,
      alt: false,
    };
    preferences.save(customized);
    assert.throws(() => preferences.save({ ...customized, shortcuts: {} }));
    assert.deepEqual(preferences.get(), customized);
    store.commitLocation('/moved-project-root', null);
    store.close();
    store = new AppStore(file, '/unused-default');
    preferences = new InteractionSettingsStore(store);
    assert.equal(store.root, '/moved-project-root');
    assert.deepEqual(preferences.get(), customized);
    preferences.save(defaultInteractionSettings());
    assert.deepEqual(preferences.get(), defaultInteractionSettings());
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
