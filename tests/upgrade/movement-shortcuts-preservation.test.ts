import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { InteractionSettingsStore } from '../../src/main/settings/interaction-settings';
import { AppStore } from '../../src/main/storage/app-store';
import { type Baseline, fileHash, history, runNode } from './history';
import { withMovementDefaults } from './interaction-settings-expectations';
import {
  assertMovementSettings,
  type MovementShortcutHistory,
  type MovementShortcutReopen,
  movementRows,
} from './movement-shortcuts-contract';

const baseline: Baseline = JSON.parse(
  await readFile(
    new URL('./movement-shortcuts-baseline.json', import.meta.url),
    'utf8',
  ),
);
assert.equal(baseline.commit, '6a11cc94149d7bad4a78e3a8b8eca7ea302a7d2d');

test('fixed five-action writer preserves custom and disabled shortcuts through read-only expansion, explicit movement save and two-process restarts', async (t) => {
  const f = await history(t, baseline);
  await runNode(new URL('./seed-movement-shortcuts.mjs', import.meta.url), [
    join(f.base, 'old-code'),
    f.data,
    baseline.commit,
  ]);
  const old: MovementShortcutHistory = JSON.parse(
    await readFile(join(f.data, 'movement-shortcuts-expected.json'), 'utf8'),
  );
  assert.equal(old.writerCommit, baseline.commit);
  assert.deepEqual(old.expected, f.expected);
  assert.deepEqual(Object.keys(old.oldSettings.shortcuts).sort(), [
    'locateLabels',
    'play',
    'redo',
    'split',
    'undo',
  ]);
  const wanted = withMovementDefaults(old.oldSettings);
  assert.deepEqual(wanted.shortcuts.undo, {
    key: 'u',
    mod: true,
    shift: false,
    alt: false,
  });
  assert.equal(wanted.shortcuts.redo, null);
  assert.equal(wanted.shortcuts.locateLabels, null);
  const contract: MovementShortcutReopen = {
    history: old,
    wanted,
    persisted: old.oldSettings,
    rows: old.rows,
  };
  const reopen = async (label: string) => {
    const file = join(f.data, `${label}.json`);
    await writeFile(file, JSON.stringify(contract), { flag: 'wx' });
    for (let index = 0; index < 2; index++)
      await runNode(
        new URL('./reopen-movement-shortcuts.ts', import.meta.url),
        [file],
      );
  };
  const before = await fileHash(join(f.app, 'app.sqlite'));
  await reopen('read-only-movement-defaults');
  assert.equal(await fileHash(join(f.app, 'app.sqlite')), before);
  const store = new AppStore(join(f.app, 'app.sqlite'), f.defaultRoot);
  try {
    await assertMovementSettings(contract, store);
    const custom = structuredClone(wanted);
    for (const [direction, key] of [
      ['Left', 'j'],
      ['Right', 'l'],
      ['Up', 'i'],
      ['Down', 'k'],
    ] as const) {
      custom.shortcuts[`move${direction}`] = {
        key,
        mod: false,
        shift: false,
        alt: false,
      };
      custom.shortcuts[`move${direction}Fast`] = {
        key,
        mod: false,
        shift: true,
        alt: false,
      };
    }
    custom.shortcuts.moveDownFast = null;
    new InteractionSettingsStore(store).save(custom);
    contract.wanted = custom;
    contract.persisted = custom;
    contract.rows = movementRows(f.app);
    assert.deepEqual(contract.rows.projects, old.rows.projects);
    assert.deepEqual(contract.rows.saves, old.rows.saves);
    assert.deepEqual(
      contract.rows.settings.filter((row) => row.key !== 'interactions'),
      old.rows.settings.filter((row) => row.key !== 'interactions'),
    );
    for (const action of [
      'play',
      'split',
      'undo',
      'redo',
      'locateLabels',
    ] as const)
      assert.deepEqual(
        custom.shortcuts[action],
        old.oldSettings.shortcuts[action],
      );
    await assertMovementSettings(contract, store);
  } finally {
    store.close();
  }
  await reopen('explicit-movement-save');
  t.diagnostic(
    `Archived ${baseline.commit} public settings writer; old raw rows unchanged on reads; explicit new movement bindings survive two independent restarts with projects, queued ready, source hashes and all original bindings preserved.`,
  );
});
