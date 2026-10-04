import assert from 'node:assert/strict';
import { renameSync, symlinkSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import {
  runStartupRecovery,
  type StartupRecoveryAction,
} from '../src/main/startup/startup-recovery';
import { AppStore } from '../src/main/storage/app-store';
import { readAppStoreRoot } from '../src/main/storage/app-store-guard';
import { Library } from '../src/main/storage/library';
import { LibraryOpenError } from '../src/main/storage/library-open-error';
import { MANAGED_DATA_DIRECTORIES } from '../src/main/storage/startup-checks';

async function fixture(t: TestContext) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-startup-')),
  );
  t.after(() => rm(base, { recursive: true, force: true }));
  const data = join(base, 'app');
  const root = join(base, 'original-projects');
  const fallback = join(base, 'unused-default');
  await mkdir(data);
  await mkdir(root);
  const file = join(data, 'app.sqlite');
  const store = new AppStore(file, root);
  store.close();
  return { base, data, root, fallback, file };
}
function change(file: string, sql: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
const missing = async (file: string) =>
  assert.rejects(lstat(file), { code: 'ENOENT' });

test('a clean first profile tolerates empty prepared folders and persists the original root on reopen', async (t) => {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-first-start-')),
  );
  t.after(() => rm(base, { recursive: true, force: true }));
  const data = join(base, 'app');
  const root = join(base, 'projects');
  await mkdir(join(data, 'staging'), { recursive: true });
  await mkdir(join(data, 'workspace-drafts'));
  await writeFile(join(data, 'Preferences'), '{}');
  let library = await Library.open(data, root);
  const first = await library.projects.create('首次启动');
  await library.close();
  const fallback = join(base, 'must-not-be-created');
  library = await Library.open(data, fallback);
  assert.equal(library.state().root, root);
  assert.equal(
    (await library.projects.open(first.project.id)).project.name,
    '首次启动',
  );
  await library.close();
  await missing(fallback);
});

for (const [name, mutate] of [
  ['zero-byte', async (file: string) => writeFile(file, '')],
  ['not-sqlite', async (file: string) => writeFile(file, 'not a database')],
  [
    'future-version',
    async (file: string) => change(file, 'PRAGMA user_version=999'),
  ],
  [
    'missing-table',
    async (file: string) => change(file, 'DROP TABLE settings'),
  ],
  [
    'missing-root',
    async (file: string) =>
      change(file, "DELETE FROM settings WHERE key='root'"),
  ],
  [
    'empty-root',
    async (file: string) =>
      change(file, "UPDATE settings SET value='' WHERE key='root'"),
  ],
  [
    'relative-root',
    async (file: string) =>
      change(
        file,
        "UPDATE settings SET value='relative/path' WHERE key='root'",
      ),
  ],
  [
    'wrong-schema',
    async (file: string) =>
      change(file, 'ALTER TABLE projects ADD COLUMN unknown TEXT'),
  ],
  [
    'missing-unique',
    async (file: string) =>
      change(
        file,
        'DROP TABLE saves; CREATE TABLE saves(id TEXT PRIMARY KEY,result_key TEXT NOT NULL,payload TEXT NOT NULL)',
      ),
  ],
  [
    'invalid-json',
    async (file: string) =>
      change(file, "INSERT INTO settings VALUES('migration', '{bad json')"),
  ],
] as const) {
  test(`existing ${name} application database fails closed without changing bytes or creating a default library`, async (t) => {
    const f = await fixture(t);
    await mutate(f.file);
    const before = await readFile(f.file);
    const modified = (await lstat(f.file)).mtimeMs;
    const entries = await readdir(f.data);
    for (let attempt = 0; attempt < 3; attempt++)
      await assert.rejects(Library.open(f.data, f.fallback), LibraryOpenError);
    assert.deepEqual(await readFile(f.file), before);
    assert.equal((await lstat(f.file)).mtimeMs, modified);
    assert.deepEqual(await readdir(f.data), entries);
    await missing(f.fallback);
    assert.deepEqual(await readdir(f.root), []);
  });
}

test('rejecting a newer live WAL database does not change its database, WAL, journal mode or default directory', async (t) => {
  const f = await fixture(t);
  const writer = new DatabaseSync(f.file);
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA user_version=999');
    const before = await readFile(f.file);
    const wal = await readFile(`${f.file}-wal`);
    await assert.rejects(Library.open(f.data, f.fallback), /版本/);
    assert.deepEqual(await readFile(f.file), before);
    assert.deepEqual(await readFile(`${f.file}-wal`), wal);
    assert.equal(
      writer.prepare('PRAGMA journal_mode').get()?.journal_mode,
      'wal',
    );
    await missing(f.fallback);
  } finally {
    writer.close();
  }
});

for (const kind of ['removed', 'symlink'] as const) {
  test(`the existing database ${kind} after read-only preflight is never created or overwritten by the writer`, async (t) => {
    const f = await fixture(t);
    const backup = join(f.data, 'original.sqlite');
    const replacement = join(f.data, 'other.sqlite');
    const other = new AppStore(replacement, f.root);
    other.close();
    const bytes = await readFile(replacement);
    const close = DatabaseSync.prototype.close;
    let moved = false;
    t.mock.method(
      DatabaseSync.prototype,
      'close',
      function (this: DatabaseSync) {
        close.call(this);
        if (!moved) {
          moved = true;
          renameSync(f.file, backup);
          if (kind === 'symlink') symlinkSync(replacement, f.file);
        }
      },
    );
    assert.throws(() => new AppStore(f.file, f.fallback, { mode: 'existing' }));
    if (kind === 'removed') await missing(f.file);
    else assert.equal((await lstat(f.file)).isSymbolicLink(), true);
    assert.deepEqual(await readFile(replacement), bytes);
    assert.equal(readAppStoreRoot(backup), f.root);
  });
}

test('constructor closes its writable connection when fresh initialization fails', async (t) => {
  const f = await fixture(t);
  const file = join(f.data, 'new.sqlite');
  const exec = DatabaseSync.prototype.exec;
  const close = DatabaseSync.prototype.close;
  let closed = 0;
  t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.includes('CREATE TABLE settings'))
        throw new Error('injected initialization failure');
      return exec.call(this, sql);
    },
  );
  t.mock.method(DatabaseSync.prototype, 'close', function (this: DatabaseSync) {
    closed++;
    return close.call(this);
  });
  assert.throws(() => new AppStore(file, f.root), /injected/);
  assert.equal(closed, 1);
});

test('a missing app database with managed files, SQLite sidecars, drafts or an existing project never becomes a new profile', async (t) => {
  const traces = [
    ...MANAGED_DATA_DIRECTORIES.map((directory) => `${directory}/keep.bin`),
    '.afflatus-package-test/keep.bin',
    'app.sqlite-wal',
    'app.sqlite-shm',
    'app.sqlite-journal',
    'project',
  ];
  for (const trace of traces)
    await t.test(trace, async (t) => {
      const f = await fixture(t);
      await rm(f.file);
      const path =
        trace === 'project'
          ? join(
              f.fallback,
              '00000000-0000-4000-8000-000000000001',
              'project.sqlite',
            )
          : join(f.data, trace);
      const { dirname } = await import('node:path');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'preserve');
      await assert.rejects(Library.open(f.data, f.fallback), /缺失.*资料/);
      await missing(f.file);
      assert.equal(await readFile(path, 'utf8'), 'preserve');
      if (trace !== 'project') await missing(f.fallback);
    });
});

test('an offline original root can be put back and retried without changing its app index, queue or location', async (t) => {
  const f = await fixture(t);
  let library = await Library.open(f.data, f.fallback);
  const snapshot = await library.projects.create('重连后仍在');
  await library.gate.block();
  const queued = await library.acceptResult(
    {
      projectId: snapshot.project.id,
      resultKey: 'waiting',
      name: 'keep.mp4',
      kind: 'video',
      extension: 'mp4',
    },
    Readable.from('waiting bytes'),
  );
  await library.close();
  const before = await readFile(f.file);
  const detached = join(f.base, 'detached');
  await rename(f.root, detached);
  await assert.rejects(
    Library.open(f.data, f.fallback),
    (error: unknown) =>
      error instanceof LibraryOpenError &&
      error.stage === 'projects' &&
      error.projectRoot === f.root,
  );
  assert.deepEqual(await readFile(f.file), before);
  await missing(f.root);
  await missing(f.fallback);
  assert.equal(
    await readFile(join(f.data, 'staging', `${queued.id}.ready`), 'utf8'),
    'waiting bytes',
  );
  await rename(detached, f.root);
  library = await Library.open(f.data, f.fallback);
  await library.saves.idle();
  assert.equal(library.state().root, f.root);
  assert.equal(
    (await library.projects.open(snapshot.project.id)).assets[0]?.id,
    queued.id,
  );
  await library.close();
});

test('a read-only original root blocks startup before touching the application database and works after permissions return', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.file);
  await chmod(f.root, 0o555);
  try {
    await assert.rejects(Library.open(f.data, f.fallback), /权限|只读/);
    assert.deepEqual(await readFile(f.file), before);
    await missing(f.fallback);
  } finally {
    await chmod(f.root, 0o755);
  }
  const library = await Library.open(f.data, f.fallback);
  await library.close();
});

test('startup recovery only retries after explicit action and keeps location failures inside the original failure dialog', async () => {
  const failure = new Error('offline');
  const actions: StartupRecoveryAction[] = [
    'show-data',
    'show-projects',
    'retry',
  ];
  let attempts = 0;
  let reveals = 0;
  const result = await runStartupRecovery(
    async () => {
      if (++attempts === 1) throw failure;
      return 'opened';
    },
    async (reason, locationError) => {
      assert.equal(reason, failure);
      assert.equal(attempts, 1);
      if (reveals === 1) assert.match(locationError ?? '', /无法打开/);
      return actions.shift() ?? 'quit';
    },
    async () => {
      if (++reveals === 1) throw new Error('permission denied');
    },
  );
  assert.equal(result, 'opened');
  assert.equal(attempts, 2);
  assert.equal(reveals, 2);
  assert.equal(
    await runStartupRecovery(
      async () => {
        throw failure;
      },
      async () => 'quit',
      async () => {
        assert.fail('no location requested');
      },
    ),
    null,
  );
});
