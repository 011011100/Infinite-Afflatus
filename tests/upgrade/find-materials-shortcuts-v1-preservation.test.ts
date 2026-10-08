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
    new URL('./find-materials-shortcuts-v1-baseline.json', import.meta.url),
    'utf8',
  ),
);
assert.equal(baseline.commit, '3f594d78d8e14cd60112726a5808b254351da94b');

for (const mode of ['custom', 'disabled'] as const) {
  test(`fixed fourteen-action writer retains ${mode} material find and all original actions through reads, unrelated edits and two-process restarts`, async (t) => {
    const f = await history(t, baseline);
    await runNode(
      new URL('./seed-find-materials-shortcuts-v1.mjs', import.meta.url),
      [join(f.base, 'old-code'), f.data, baseline.commit, mode],
    );
    const old: MovementShortcutHistory & { mode: typeof mode } = JSON.parse(
      await readFile(
        join(f.data, 'find-materials-shortcuts-v1-expected.json'),
        'utf8',
      ),
    );
    assert.equal(old.writerCommit, baseline.commit);
    assert.equal(old.mode, mode);
    assert.deepEqual(old.expected, f.expected);
    assert.equal(Object.keys(old.oldSettings.shortcuts).length, 14);
    // Independent full expected contract: do not derive old values from the
    // current defaults, upgrade helper or current service's return value.
    const originalActions = {
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
    };
    const findMaterials =
      mode === 'custom'
        ? { key: 'j', mod: true, shift: true, alt: false }
        : null;
    assert.deepEqual(old.oldSettings, {
      version: 1,
      longPressSplit: false,
      shortcuts: { ...originalActions, findMaterials },
    });
    const contract: MovementShortcutReopen = {
      history: old,
      wanted: structuredClone(old.oldSettings),
      persisted: old.oldSettings,
      rows: old.rows,
    };
    const reopen = async (label: string) => {
      const file = join(f.data, `${mode}-${label}.json`);
      await writeFile(file, JSON.stringify(contract), { flag: 'wx' });
      for (let index = 0; index < 2; index++)
        await runNode(
          new URL('./reopen-movement-shortcuts.ts', import.meta.url),
          [file],
        );
    };
    const before = await fileHash(join(f.app, 'app.sqlite'));
    await reopen('read-only');
    assert.equal(await fileHash(join(f.app, 'app.sqlite')), before);
    const store = new AppStore(join(f.app, 'app.sqlite'), f.defaultRoot);
    try {
      await assertMovementSettings(contract, store);
      const custom = structuredClone(old.oldSettings);
      custom.shortcuts.play = {
        key: 'b',
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
      const { play: _, ...unchanged } = custom.shortcuts;
      const { play: __, ...original } = old.oldSettings.shortcuts;
      assert.deepEqual(unchanged, original);
      assert.deepEqual(custom.shortcuts.findMaterials, findMaterials);
      await assertMovementSettings(contract, store);
    } finally {
      store.close();
    }
    await reopen('after-unrelated-action-save');
    t.diagnostic(
      `Fixed public writer ${baseline.commit}, findMaterials=${mode}; fourteen independently expected settings, read-only app database hash/raw rows and all original source/project/ready hashes retained; another action's explicit edit survives two isolated current process restarts.`,
    );
  });
}
