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
  moveShortcutDelta,
  shortcutAction,
} from '../src/shared/interaction/shortcuts';

const input = (mac: boolean, rest: Partial<KeyInput> = {}): KeyInput => ({
  key: 'k',
  ctrlKey: !mac,
  metaKey: mac,
  shiftKey: false,
  altKey: false,
  ...rest,
});

// A unit input only. Real historical writes are tested through the pinned
// thirteen-action public writer in tests/upgrade.
const oldSettings = () => {
  const { findMaterials: _, ...shortcuts } =
    defaultInteractionSettings().shortcuts;
  return { version: 1, longPressSplit: false, shortcuts };
};

test('material find uses exact Command/Ctrl K and never becomes a movement command', () => {
  const settings = defaultInteractionSettings();
  validateInteractionSettings(settings);
  for (const mac of [true, false]) {
    assert.equal(
      shortcutAction(input(mac), settings.shortcuts, mac),
      'findMaterials',
    );
    assert.equal(
      formatShortcut(settings.shortcuts.findMaterials, mac),
      mac ? '⌘ K' : 'Ctrl + K',
    );
    for (const changed of [
      { ctrlKey: false, metaKey: false },
      { ctrlKey: mac, metaKey: !mac },
      { ctrlKey: true, metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { repeat: true },
      { isComposing: true },
    ])
      assert.equal(
        shortcutAction(input(mac, changed), settings.shortcuts, mac),
        null,
      );
  }
  assert.equal(moveShortcutDelta('findMaterials'), null);
});

test('material find can be rebound or cleared without changing other actions', () => {
  const settings = defaultInteractionSettings();
  const before = structuredClone(settings.shortcuts);
  settings.shortcuts.findMaterials = {
    key: 'j',
    mod: true,
    shift: true,
    alt: false,
  };
  validateInteractionSettings(settings);
  for (const mac of [true, false]) {
    assert.equal(shortcutAction(input(mac), settings.shortcuts, mac), null);
    assert.equal(
      shortcutAction(
        input(mac, { key: 'J', shiftKey: true }),
        settings.shortcuts,
        mac,
      ),
      'findMaterials',
    );
  }
  settings.shortcuts.findMaterials = null;
  validateInteractionSettings(settings);
  for (const mac of [true, false])
    assert.equal(
      shortcutAction(
        input(mac, { key: 'J', shiftKey: true }),
        settings.shortcuts,
        mac,
      ),
      null,
    );
  const { findMaterials: _, ...remaining } = settings.shortcuts;
  const { findMaterials: __, ...original } = before;
  assert.deepEqual(remaining, original);
});

test('missing material find yields to every existing Mod K binding and preserves explicit values', () => {
  const old = oldSettings();
  const before = structuredClone(old);
  const upgraded = upgradeInteractionSettings(old);
  assert.deepEqual(upgraded.shortcuts.findMaterials, {
    key: 'k',
    mod: true,
    shift: false,
    alt: false,
  });
  assert.deepEqual(old, before);
  for (const action of Object.keys(
    old.shortcuts,
  ) as (keyof typeof old.shortcuts)[]) {
    const conflict = structuredClone(old);
    conflict.shortcuts[action] = {
      key: 'k',
      mod: true,
      shift: false,
      alt: false,
    };
    const untouched = structuredClone(conflict);
    const next = upgradeInteractionSettings(conflict);
    assert.equal(next.shortcuts.findMaterials, null, action);
    const { findMaterials: _, ...preserved } = next.shortcuts;
    assert.deepEqual(preserved, conflict.shortcuts);
    assert.deepEqual(conflict, untouched);
  }
  for (const binding of [
    null,
    { key: 'j', mod: false, shift: false, alt: false },
  ]) {
    const supplied = {
      ...old,
      shortcuts: { ...old.shortcuts, findMaterials: binding },
    };
    assert.deepEqual(upgradeInteractionSettings(supplied), supplied);
  }
});

test('material find reads do not rewrite old storage; explicit saves, clear and rejected conflicts survive reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'afflatus-find-settings-'));
  const file = join(directory, 'app.sqlite');
  let store = new AppStore(file, join(directory, 'projects'));
  try {
    const old = oldSettings();
    store.set('interactions', old);
    const before = await readFile(file);
    let preferences = new InteractionSettingsStore(store);
    const upgraded = preferences.get();
    assert.deepEqual(store.get('interactions'), old);
    assert.deepEqual(await readFile(file), before);
    const custom = structuredClone(upgraded);
    custom.shortcuts.findMaterials = {
      key: 'j',
      mod: true,
      shift: true,
      alt: false,
    };
    assert.deepEqual(preferences.save(custom), custom);
    store.close();
    store = new AppStore(file, join(directory, 'unused-default'));
    preferences = new InteractionSettingsStore(store);
    assert.deepEqual(preferences.get(), custom);
    assert.deepEqual(store.get('interactions'), custom);
    const savedBytes = await readFile(file);
    assert.throws(
      () =>
        preferences.save({
          ...custom,
          shortcuts: {
            ...custom.shortcuts,
            findMaterials: custom.shortcuts.undo,
          },
        }),
      /重复/,
    );
    assert.deepEqual(await readFile(file), savedBytes);
    custom.shortcuts.findMaterials = null;
    preferences.save(custom);
    store.close();
    store = new AppStore(file, join(directory, 'unused-default'));
    preferences = new InteractionSettingsStore(store);
    assert.deepEqual(preferences.get(), custom);
    assert.equal(preferences.get().shortcuts.findMaterials, null);
    assert.deepEqual(store.get('interactions'), custom);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
