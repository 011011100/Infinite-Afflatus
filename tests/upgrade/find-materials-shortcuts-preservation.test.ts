import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { InteractionSettingsStore } from '../../src/main/settings/interaction-settings';
import { AppStore } from '../../src/main/storage/app-store';
import { type Baseline, fileHash, history, runNode } from './history';
import { withFindMaterialsDefault } from './interaction-settings-expectations';
import {
  assertMovementSettings,
  type MovementShortcutHistory,
  type MovementShortcutReopen,
  movementRows,
} from './movement-shortcuts-contract';

const baseline: Baseline = JSON.parse(
  await readFile(
    new URL('./movement-shortcuts-v1-baseline.json', import.meta.url),
    'utf8',
  ),
);
assert.equal(baseline.commit, '115c08d1d05d02536994d9843c548f41f8e6c777');

test('fixed thirteen-action writer keeps its Mod K command through find-default upgrade and explicit rebind across independent restarts', async (t) => {
  const f = await history(t, baseline);
  const argumentsForWriter = [
    join(f.base, 'old-code'),
    f.data,
    baseline.commit,
  ];
  await runNode(
    new URL('./seed-movement-shortcuts-v1.mjs', import.meta.url),
    argumentsForWriter,
  );
  await runNode(
    new URL('./seed-find-materials-conflict.mjs', import.meta.url),
    argumentsForWriter,
  );
  const original: MovementShortcutHistory = JSON.parse(
    await readFile(join(f.data, 'movement-shortcuts-v1-expected.json'), 'utf8'),
  );
  const old: MovementShortcutHistory = JSON.parse(
    await readFile(
      join(f.data, 'find-materials-conflict-expected.json'),
      'utf8',
    ),
  );
  assert.equal(old.writerCommit, baseline.commit);
  assert.deepEqual(old.expected, f.expected);
  assert.equal(Object.keys(old.oldSettings.shortcuts).length, 13);
  assert.equal(
    Object.hasOwn(old.oldSettings.shortcuts, 'findMaterials'),
    false,
  );
  assert.deepEqual(old.oldSettings.shortcuts.undo, {
    key: 'k',
    mod: true,
    shift: false,
    alt: false,
  });
  const { undo: _, ...preserved } = old.oldSettings.shortcuts;
  const { undo: __, ...originalBindings } = original.oldSettings.shortcuts;
  assert.deepEqual(preserved, originalBindings);
  assert.deepEqual(old.files, original.files);
  assert.deepEqual(old.rows.projects, original.rows.projects);
  assert.deepEqual(old.rows.saves, original.rows.saves);
  assert.deepEqual(
    old.rows.settings.filter((row) => row.key !== 'interactions'),
    original.rows.settings.filter((row) => row.key !== 'interactions'),
  );
  const contract: MovementShortcutReopen = {
    history: old,
    wanted: withFindMaterialsDefault(old.oldSettings),
    persisted: old.oldSettings,
    rows: old.rows,
  };
  assert.equal(contract.wanted.shortcuts.findMaterials, null);
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
  await reopen('legacy-mod-k-read-only');
  assert.equal(await fileHash(join(f.app, 'app.sqlite')), before);
  const store = new AppStore(join(f.app, 'app.sqlite'), f.defaultRoot);
  try {
    await assertMovementSettings(contract, store);
    const custom = structuredClone(contract.wanted);
    custom.shortcuts.findMaterials = {
      key: 'j',
      mod: true,
      shift: true,
      alt: false,
    };
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
    const { findMaterials: _, ...unchanged } = custom.shortcuts;
    assert.deepEqual(unchanged, old.oldSettings.shortcuts);
    await assertMovementSettings(contract, store);
  } finally {
    store.close();
  }
  await reopen('explicit-find-rebind');
  t.diagnostic(
    `Archived public writer ${baseline.commit} actually saved the thirteen-action Mod K preference; current reads preserve its raw database and return findMaterials=null; explicit new binding survives two process restarts with every old action, ready job and source hash retained.`,
  );
});
