import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [source, directory, commit] = process.argv.slice(2);
assert.ok(source && directory);
assert.equal(commit, '6a11cc94149d7bad4a78e3a8b8eca7ea302a7d2d');
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
const settings = {
  version: 1,
  longPressSplit: false,
  shortcuts: {
    play: { key: 'p', mod: false, shift: false, alt: false },
    split: { key: 'g', mod: true, shift: true, alt: false },
    undo: { key: 'u', mod: true, shift: false, alt: false },
    redo: null,
    locateLabels: null,
  },
};
const store = new AppStore(database, expected.root);
try {
  const service = new InteractionSettingsStore(store);
  assert.deepEqual(Object.keys(service.get().shortcuts).sort(), [
    'locateLabels',
    'play',
    'redo',
    'split',
    'undo',
  ]);
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
  join(directory, 'movement-shortcuts-expected.json'),
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
