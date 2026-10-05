// Every settings write below uses the immutable feature commit's public service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const expected = JSON.parse(
  await readFile(join(directory, 'expected.json'), 'utf8'),
);
const app = join(directory, 'app');
const database = join(app, 'app.sqlite');
// Declare the expected business values before saving; never use save/get output
// as a replacement for these eight independent bindings and original actions.
const settings = {
  version: 1,
  longPressSplit: false,
  shortcuts: {
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
  },
};
const store = new AppStore(database, expected.root);
try {
  const service = new InteractionSettingsStore(store);
  assert.equal(Object.keys(service.get().shortcuts).length, 13);
  assert.deepEqual(service.save(settings), settings);
  assert.deepEqual(store.get('interactions'), settings);
  assert.deepEqual(store.jobs(), expected.jobs);
} finally {
  store.close();
}
const db = new DatabaseSync(database, { readOnly: true });
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
const files = [];
for (const file of [
  ...expected.projects.map((project) =>
    join(expected.root, project.project.folder, 'project.sqlite'),
  ),
  join(expected.root, expected.pendingProject.folder, 'project.sqlite'),
  join(app, 'staging', `${expected.queued.id}.ready`),
]) {
  const bytes = await readFile(file);
  files.push({
    file,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
await writeFile(
  join(directory, 'movement-shortcuts-v1-expected.json'),
  JSON.stringify(
    {
      writerCommit: commit,
      app,
      defaultRoot: join(directory, 'must-not-create-default-root'),
      expected,
      oldSettings: settings,
      rows,
      files,
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
