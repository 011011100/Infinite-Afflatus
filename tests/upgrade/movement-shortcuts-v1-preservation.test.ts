import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { InteractionSettingsStore } from '../../src/main/settings/interaction-settings';
import { AppStore } from '../../src/main/storage/app-store';
import { type Baseline, fileHash, history, runNode } from './history';
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

test('fixed eight-action settings writer retains independent custom/null bindings, locator arrow and exact raw rows through current edits and two-process restarts', async (t) => {
  const f = await history(t, baseline);
  await runNode(new URL('./seed-movement-shortcuts-v1.mjs', import.meta.url), [
    join(f.base, 'old-code'),
    f.data,
    baseline.commit,
  ]);
  const old: MovementShortcutHistory = JSON.parse(
    await readFile(join(f.data, 'movement-shortcuts-v1-expected.json'), 'utf8'),
  );
  assert.equal(old.writerCommit, baseline.commit);
  assert.deepEqual(old.expected, f.expected);
  assert.equal(Object.keys(old.oldSettings.shortcuts).length, 13);
  assert.deepEqual(old.oldSettings.shortcuts, {
    play: { key: 'p', mod: false, shift: false, alt: false },
    split: { key: 'g', mod: true, shift: true, alt: false },
    undo: { key: 'u', mod: true, shift: false, alt: false },
    redo: null,
    locateLabels: { key: 'arrowright', mod: false, shift: false, alt: false },
    moveLeft: { key: 'a', mod: false, shift: false, alt: false },
    moveRight: null,
    moveUp: { key: 'w', mod: false, shift: false, alt: false },
    moveDown: { key: 's', mod: false, shift: false, alt: false },
    moveLeftFast: { key: 'a', mod: false, shift: true, alt: false },
    moveRightFast: { key: 'd', mod: false, shift: true, alt: false },
    moveUpFast: null,
    moveDownFast: { key: 'arrowdown', mod: false, shift: true, alt: false },
  });
  const contract: MovementShortcutReopen = {
    history: old,
    wanted: structuredClone(old.oldSettings),
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
  await reopen('fixed-eight-actions-read-only');
  assert.equal(await fileHash(join(f.app, 'app.sqlite')), before);
  const store = new AppStore(join(f.app, 'app.sqlite'), f.defaultRoot);
  try {
    await assertMovementSettings(contract, store);
    const custom = structuredClone(old.oldSettings);
    custom.shortcuts.moveRightFast = {
      key: 'e',
      mod: false,
      shift: false,
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
    for (const action of Object.keys(
      old.oldSettings.shortcuts,
    ) as (keyof typeof custom.shortcuts)[])
      if (action !== 'moveRightFast')
        assert.deepEqual(
          custom.shortcuts[action],
          old.oldSettings.shortcuts[action],
        );
    assert.equal(custom.shortcuts.moveRight, null);
    assert.equal(custom.shortcuts.moveUpFast, null);
    await assertMovementSettings(contract, store);
  } finally {
    store.close();
  }
  await reopen('fixed-eight-actions-after-explicit-save');
  t.diagnostic(
    `Immutable public writer ${baseline.commit}; all eight movement fields, original actions and explicit nulls checked independently; read-only database hashes and non-settings raw rows preserved; current edit followed by two isolated process restarts without consuming ready media.`,
  );
});
