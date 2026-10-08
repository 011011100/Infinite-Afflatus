// Historical settings are written only by the fixed commit's public service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [source, directory, commit, mode] = process.argv.slice(2);
assert.ok(source && directory);
assert.equal(commit, '3f594d78d8e14cd60112726a5808b254351da94b');
assert.ok(['custom', 'disabled'].includes(mode));
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
// These fourteen expected values precede the old API call. Neither old nor
// current save/get output is used to manufacture the expected business values.
const settings = {
  version: 1,
  longPressSplit: false,
  shortcuts: {
    play: { key: 'p', mod: false, shift: false, alt: false },
    split: { key: 'g', mod: true, shift: true, alt: false },
    undo: { key: 'u', mod: true, shift: false, alt: false },
    redo: null,
    locateLabels: { key: 'arrowright', mod: false, shift: false, alt: false },
    findMaterials:
      mode === 'custom'
        ? { key: 'j', mod: true, shift: true, alt: false }
        : null,
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
function rawRows() {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return Object.fromEntries(
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
}
const beforeRows = rawRows();
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
const store = new AppStore(database, expected.root);
try {
  const service = new InteractionSettingsStore(store);
  assert.equal(Object.keys(service.get().shortcuts).length, 14);
  assert.deepEqual(service.save(settings), settings);
  assert.deepEqual(store.get('interactions'), settings);
  assert.deepEqual(store.jobs(), expected.jobs);
} finally {
  store.close();
}
const rows = rawRows();
assert.deepEqual(rows.projects, beforeRows.projects);
assert.deepEqual(rows.saves, beforeRows.saves);
assert.deepEqual(
  rows.settings.filter((row) => row.key !== 'interactions'),
  beforeRows.settings.filter((row) => row.key !== 'interactions'),
);
for (const file of files) {
  const bytes = await readFile(file.file);
  assert.equal(bytes.length, file.size);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
}
await writeFile(
  join(directory, 'find-materials-shortcuts-v1-expected.json'),
  JSON.stringify(
    {
      writerCommit: commit,
      mode,
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
