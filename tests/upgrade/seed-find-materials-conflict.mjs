// Extend the fixed thirteen-action fixture with a legitimate old Mod K choice.
// Only the archived public settings service writes the historical database.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [source, directory, commit] = process.argv.slice(2);
assert.ok(source && directory);
assert.equal(commit, '115c08d1d05d02536994d9843c548f41f8e6c777');
const { AppStore } = await import(
  pathToFileURL(join(source, 'src/main/storage/app-store.ts')).href
);
const { InteractionSettingsStore } = await import(
  pathToFileURL(join(source, 'src/main/settings/interaction-settings.ts')).href
);
const original = JSON.parse(
  await readFile(
    join(directory, 'movement-shortcuts-v1-expected.json'),
    'utf8',
  ),
);
assert.equal(original.writerCommit, commit);
const oldSettings = structuredClone(original.oldSettings);
oldSettings.shortcuts.undo = {
  key: 'k',
  mod: true,
  shift: false,
  alt: false,
};
assert.equal(Object.keys(oldSettings.shortcuts).length, 13);
assert.equal(Object.hasOwn(oldSettings.shortcuts, 'findMaterials'), false);
const file = join(original.app, 'app.sqlite');
const store = new AppStore(file, original.expected.root);
try {
  assert.deepEqual(
    new InteractionSettingsStore(store).save(oldSettings),
    oldSettings,
  );
  assert.deepEqual(store.get('interactions'), oldSettings);
  assert.deepEqual(store.jobs(), original.expected.jobs);
} finally {
  store.close();
}
const db = new DatabaseSync(file, { readOnly: true });
let rows;
try {
  rows = Object.fromEntries(
    ['settings', 'projects', 'saves'].map((table) => [
      table,
      db
        .prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) => ({ ...row })),
    ]),
  );
} finally {
  db.close();
}
assert.deepEqual(rows.projects, original.rows.projects);
assert.deepEqual(rows.saves, original.rows.saves);
assert.deepEqual(
  rows.settings.filter((row) => row.key !== 'interactions'),
  original.rows.settings.filter((row) => row.key !== 'interactions'),
);
await writeFile(
  join(directory, 'find-materials-conflict-expected.json'),
  JSON.stringify({ ...original, oldSettings, rows }, null, 2),
  { flag: 'wx' },
);
