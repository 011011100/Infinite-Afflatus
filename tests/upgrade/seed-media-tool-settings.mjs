// Storage compatibility only: public choose and all persistence code come from
// the exact Git archive. The version inspector is injected; no media is executed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const legacyCommit = 'b477334c44f76fba6cf0fb607bcc7268c67e00cf';
const mediaCommit = '309d0b7e517ae619575d291e9702ac904d08a941';
const [source, directory, writerCommit, mode] = process.argv.slice(2);
assert.ok(source && directory);
assert.ok(mode === 'absent' || mode === 'configured');
assert.equal(writerCommit, mode === 'absent' ? legacyCommit : mediaCommit);
assert.match(writerCommit, /^[a-f0-9]{40}$/);
const { AppStore } = await import(
  pathToFileURL(join(source, 'src/main/storage/app-store.ts')).href
);
const expected = JSON.parse(
  await readFile(join(directory, 'expected.json'), 'utf8'),
);
const app = join(directory, 'app');
const database = join(app, 'app.sqlite');
const readRows = () => {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return db.prepare('SELECT key, value FROM settings ORDER BY key').all();
  } finally {
    db.close();
  }
};
const settings = readRows();
assert.ok(!settings.some((row) => row.key === 'mediaToolSettings'));
const store = new AppStore(database, expected.root);
let service;
const inspected = [];
const paths = { ffmpeg: null, ffprobe: null };
const files = [];
const capture = async (file) => {
  const bytes = await readFile(file);
  return {
    file,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};
try {
  assert.deepEqual(store.jobs(), expected.jobs);
  assert.equal(store.job(expected.queued.id).status, 'ready');
  if (mode === 'configured') {
    const { MediaToolSettings } = await import(
      pathToFileURL(join(source, 'src/main/media/media-tool-settings.ts')).href
    );
    service = new MediaToolSettings(store, {
      env: {},
      platform: 'linux',
      inspect: async (location) => {
        inspected.push({ name: location.name, command: location.command });
        return {
          ...location,
          status: 'available',
          version: 'storage-fixture-v1',
          detail: null,
        };
      },
    });
    for (const [name, folder] of [
      ['ffmpeg', '编码器 A'],
      ['ffprobe', '探测器 B'],
    ]) {
      const parent = join(directory, '组件 路径', folder);
      await mkdir(parent, { recursive: true });
      const file = join(parent, `${name} fixture`);
      await writeFile(
        file,
        `#!/bin/sh\n# storage fixture for ${name}; never executed\nexit 0\n`,
        { flag: 'wx', mode: 0o700 },
      );
      const result = await service.choose(
        name,
        async () => file,
        () => {},
      );
      assert.equal(result.settings.paths[name], file);
      assert.equal(result.report.tools[0].status, 'available');
      paths[name] = file;
      files.push(await capture(file));
    }
    assert.notEqual(paths.ffmpeg, paths.ffprobe);
    assert.deepEqual(
      inspected,
      ['ffmpeg', 'ffprobe'].map((name) => ({ name, command: paths[name] })),
    );
    assert.deepEqual(store.get('mediaToolSettings'), { version: 1, ...paths });
  }
  for (const project of [
    ...expected.projects.map((item) => item.project),
    expected.pendingProject,
  ])
    files.push(
      await capture(join(expected.root, project.folder, 'project.sqlite')),
    );
  files.push(
    await capture(join(app, 'staging', `${expected.queued.id}.ready`)),
  );
  assert.deepEqual(store.jobs(), expected.jobs);
  const rows = readRows();
  assert.deepEqual(
    rows.filter((row) => row.key !== 'mediaToolSettings'),
    settings,
  );
  await writeFile(
    join(directory, 'media-tool-settings-expected.json'),
    JSON.stringify(
      {
        writerCommit,
        app,
        defaultRoot: join(directory, 'new-default-must-not-be-used'),
        expected,
        settings,
        projects: store.projects(),
        files,
        raw: rows.find((row) => row.key === 'mediaToolSettings')?.value ?? null,
        paths,
        inspections: inspected,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
} finally {
  await service?.close();
  store.close();
}
