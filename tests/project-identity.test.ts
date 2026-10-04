import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, readdirSync, renameSync, symlinkSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { ProxyService } from '../src/main/media/proxy-service';
import {
  readProject,
  updateProject,
} from '../src/main/projects/project-database';
import { Library } from '../src/main/storage/library';
import { emptyGenerationDraft } from '../src/shared/generation/draft';
import { emptyWorkspace, newShot } from '../src/shared/generation/workspace';

async function fixture() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-identity-中文 #%-')),
  );
  const data = join(base, 'app');
  const library = await Library.open(data, join(base, 'projects'));
  const { project } = await library.projects.create('原项目');
  const { project: other } = await library.projects.create('另一个项目');
  await library.acceptResult(
    {
      projectId: project.id,
      resultKey: 'video',
      name: 'source.mp4',
      kind: 'video',
      extension: 'mp4',
    },
    Readable.from('original media'),
  );
  await library.saves.idle();
  const original = await library.projects.open(project.id);
  const database = await library.projects.databasePath(project.id);
  const otherDatabase = await library.projects.databasePath(other.id);
  const originalBytes = await readFile(database);
  const otherBytes = await readFile(otherDatabase);
  const backup = join(base, 'original.sqlite');
  const index = library.store.projects();
  return {
    base,
    data,
    library,
    project,
    other,
    original,
    database,
    otherDatabase,
    originalBytes,
    otherBytes,
    backup,
    index,
    replace() {
      renameSync(database, backup);
      copyFileSync(otherDatabase, database);
    },
    async assertUntouched() {
      assert.deepEqual(
        await readFile(database),
        otherBytes,
        'replacement database must remain byte-identical',
      );
      assert.deepEqual(
        await readFile(otherDatabase),
        otherBytes,
        'other project must remain byte-identical',
      );
      assert.deepEqual(
        await readFile(backup),
        originalBytes,
        'displaced original must remain byte-identical',
      );
      assert.deepEqual(
        library.store.projects(),
        index,
        'rejected writes must not change the recent-project index',
      );
    },
    async restore() {
      await rm(database);
      await rename(backup, database);
    },
    async dispose() {
      await library.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('replaced project database rejects all live reads/writes and preserves both projects; original resumes', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const card = f.original.canvas.cards[0];
  assert.ok(card);
  const patch = {
    before: [card],
    after: [{ ...card, position: { x: 555, y: 222 } }],
  };
  const workspace = {
    ...emptyWorkspace(),
    shots: [newShot('draft', '未保存镜头', { x: 1, y: 2 })],
  };
  f.replace();
  const operations = [
    () => f.library.projects.open(f.project.id),
    () => f.library.generation.read(f.project.id),
    () => f.library.generation.readWorkspace(f.project.id),
    () => f.library.projects.update(f.project.id, { name: '错误改名' }),
    () =>
      f.library.projects.update(f.project.id, {
        viewport: { x: 123, y: 321, zoom: 0.7 },
      }),
    () => f.library.projects.patchCanvas(f.project.id, patch),
    () =>
      f.library.generation.save(f.project.id, {
        ...emptyGenerationDraft(),
        prompt: '保留草稿',
      }),
    () => f.library.generation.saveWorkspace(f.project.id, workspace),
  ];
  for (const operation of operations) {
    await assert.rejects(operation, /项目文件与索引不匹配/);
    await f.assertUntouched();
  }
  await f.restore();
  await f.library.projects.patchCanvas(f.project.id, patch);
  const saved = await f.library.generation.saveWorkspace(
    f.project.id,
    workspace,
  );
  assert.equal(saved.revision, 1);
  assert.equal(
    (await f.library.projects.open(f.project.id)).canvas.cards[0]?.position.x,
    555,
  );
  assert.deepEqual(await readFile(f.otherDatabase), f.otherBytes);
});

test('same ID with a different folder, unsupported schema and missing viewport cannot authorize writes', async (t) => {
  for (const change of ['folder', 'schema', 'viewport'] as const) {
    await t.test(change, async (t) => {
      const f = await fixture();
      t.after(() => f.dispose());
      const db = new DatabaseSync(f.database);
      if (change === 'folder')
        db.prepare("UPDATE metadata SET value = ? WHERE key = 'project'").run(
          JSON.stringify({ ...f.project, folder: f.other.id }),
        );
      else if (change === 'schema')
        db.exec(
          'CREATE TRIGGER forbidden AFTER UPDATE ON metadata BEGIN DELETE FROM assets; END;',
        );
      else db.exec("DELETE FROM metadata WHERE key = 'viewport'");
      db.close();
      const bytes = await readFile(f.database);
      for (const operation of [
        () => f.library.projects.open(f.project.id),
        () => f.library.projects.update(f.project.id, { name: '拒绝写入' }),
        () => f.library.generation.readWorkspace(f.project.id),
      ])
        await assert.rejects(operation, /不匹配|不支持|不完整/);
      assert.deepEqual(await readFile(f.database), bytes);
      assert.deepEqual(await readFile(f.otherDatabase), f.otherBytes);
      assert.deepEqual(f.library.store.projects(), f.index);
    });
  }
});

test('writable connection revalidates identity after read-only preflight, before writable PRAGMAs', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  // WAL mode exposes even a premature journal_mode=DELETE as a byte change.
  const other = new DatabaseSync(f.otherDatabase);
  other.exec('PRAGMA journal_mode = WAL;');
  other.close();
  const replacement = await readFile(f.otherDatabase);
  const close = DatabaseSync.prototype.close;
  const mocked = t.mock.method(
    DatabaseSync.prototype,
    'close',
    function (this: DatabaseSync) {
      close.call(this);
      mocked.mock.restore();
      f.replace();
    },
  );
  assert.throws(
    () => updateProject(f.database, { name: '拒绝' }, f.project),
    /不匹配/,
  );
  assert.deepEqual(await readFile(f.database), replacement);
  assert.deepEqual(await readFile(f.otherDatabase), replacement);
  assert.deepEqual(await readFile(f.backup), f.originalBytes);
});

test('a missing database is never recreated and a returned original keeps its existing data', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  await rename(f.database, f.backup);
  await assert.rejects(
    f.library.projects.update(f.project.id, { name: '未保存名称' }),
  );
  await assert.rejects(
    f.library.generation.saveWorkspace(f.project.id, emptyWorkspace()),
  );
  await assert.rejects(readFile(f.database), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.backup), f.originalBytes);
  await rename(f.backup, f.database);
  assert.deepEqual(await f.library.projects.open(f.project.id), f.original);
  assert.deepEqual(await readFile(f.otherDatabase), f.otherBytes);
});

for (const replacement of ['missing', 'symlink'] as const) {
  test(`database becoming ${replacement} after preflight is rejected without creating or modifying files`, async (t) => {
    const f = await fixture();
    t.after(() => f.dispose());
    const close = DatabaseSync.prototype.close;
    const mocked = t.mock.method(
      DatabaseSync.prototype,
      'close',
      function (this: DatabaseSync) {
        close.call(this);
        mocked.mock.restore();
        renameSync(f.database, f.backup);
        if (replacement === 'symlink')
          symlinkSync(f.backup, f.database, 'file');
      },
    );
    assert.throws(
      () => updateProject(f.database, { name: '拒绝' }, f.project),
      replacement === 'missing' ? /unable to open database/ : /符号链接/,
    );
    if (replacement === 'missing')
      await assert.rejects(lstat(f.database), { code: 'ENOENT' });
    else {
      assert.equal((await lstat(f.database)).isSymbolicLink(), true);
      assert.equal(await realpath(f.database), f.backup);
    }
    assert.deepEqual(await readFile(f.backup), f.originalBytes);
    assert.deepEqual(await readFile(f.otherDatabase), f.otherBytes);
    assert.deepEqual(f.library.store.projects(), f.index);
  });
}

test('migration rejects a foreign database substituted between manifest identity reads and hashing', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const target = join(f.base, 'moved');
  await mkdir(target);
  const preview = await f.library.migration.prepare(target);
  const close = DatabaseSync.prototype.close;
  let projectReads = 0;
  const mocked = t.mock.method(
    DatabaseSync.prototype,
    'close',
    function (this: DatabaseSync) {
      const file = this.prepare('PRAGMA database_list').get()?.file;
      close.call(this);
      if (file === f.database && ++projectReads === 3) {
        // discover, ProjectService.open and readProxies have accepted A; manifest
        // has not yet fingerprinted project.sqlite and will copy B's bytes.
        mocked.mock.restore();
        f.replace();
      }
    },
  );
  await f.library.migration.start(preview.token);
  await f.library.migration.idle();
  assert.equal(projectReads, 3);
  assert.equal(f.library.state().root, dirname(dirname(f.database)));
  assert.equal(f.library.migration.journal?.switched, false);
  assert.equal(f.library.state().migration?.phase, 'failed');
  assert.match(f.library.state().migration?.error ?? '', /不匹配/);
  const copied = f.library.migration.journal?.files.find(
    (entry) => entry.relativePath === `${f.project.folder}/project.sqlite`,
  );
  assert.equal(
    copied?.copied?.sha256,
    createHash('sha256').update(f.otherBytes).digest('hex'),
    'fault must reach target-copy validation before owned copies are cleaned',
  );
  await f.assertUntouched();
});

for (const method of ['save', 'saveWorkspace'] as const) {
  test(`${method} rejects replacement after opening the original project`, async (t) => {
    const f = await fixture();
    t.after(() => f.dispose());
    const path = f.library.projects.databasePath.bind(f.library.projects);
    let calls = 0;
    t.mock.method(f.library.projects, 'databasePath', async (id: string) => {
      const file = await path(id);
      if (id === f.project.id && ++calls === 2) f.replace();
      return file;
    });
    await assert.rejects(
      method === 'save'
        ? f.library.generation.save(f.project.id, emptyGenerationDraft())
        : f.library.generation.saveWorkspace(f.project.id, emptyWorkspace()),
      /不匹配/,
    );
    assert.equal(calls, 2);
    await f.assertUntouched();
  });
}

test('save queue detects replacement during copying, retains staged bytes and retries after original returns', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  await f.library.gate.block();
  const bytes = Buffer.from('new unsaved reference');
  const job = await f.library.acceptResult(
    {
      projectId: f.project.id,
      resultKey: 'late-result',
      name: '新素材.txt',
      kind: 'text',
      usage: 'reference',
      extension: 'txt',
    },
    Readable.from(bytes),
  );
  const stage = f.library.staging.path.bind(f.library.staging);
  const mock = t.mock.method(f.library.staging, 'path', (id: string) => {
    const file = stage(id);
    mock.mock.restore();
    f.replace();
    return file;
  });
  f.library.gate.release();
  f.library.saves.kick();
  await f.library.saves.idle();
  const failed = f.library.store.job(job.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /不匹配/);
  assert.deepEqual(await readFile(stage(job.id)), bytes);
  assert.ok(failed.outputRelativePath);
  assert.deepEqual(
    await readFile(join(dirname(f.database), failed.outputRelativePath)),
    bytes,
    'fault occurs after publication and before registration',
  );
  await f.assertUntouched();
  await f.restore();
  await f.library.saves.retry(job.id);
  await f.library.saves.idle();
  assert.equal(f.library.store.job(job.id).status, 'saved');
  assert.equal(
    (await f.library.projects.open(f.project.id)).assets.filter(
      (asset) => asset.id === job.id,
    ).length,
    1,
  );
  await assert.rejects(readFile(stage(job.id)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.otherDatabase), f.otherBytes);
});

test('proxy registration rejects a replacement after encoding and publication', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const proxy = new ProxyService(
    f.library.projects,
    f.library.gate,
    f.library.store,
    f.data,
    async (_input, output) => {
      await writeFile(output, 'synthetic proxy bytes');
    },
  );
  t.after(() => proxy.close());
  const summary = f.library.projects.summary.bind(f.library.projects);
  let replaced = false;
  t.mock.method(f.library.projects, 'summary', (id: string) => {
    if (!replaced && readdirSync(join(dirname(f.database), 'cache')).length) {
      replaced = true;
      f.replace();
    }
    return summary(id);
  });
  const warn = t.mock.method(console, 'warn', () => undefined);
  assert.deepEqual(
    await proxy.ensure(f.project.id, f.original.assets[0]?.id ?? ''),
    { ready: false },
  );
  assert.equal(replaced, true);
  assert.match(String(warn.mock.calls[0]?.arguments[1]), /不匹配/);
  await f.assertUntouched();
});

test('same-project external revisions remain conflicts; guards never replace client revisions', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const staleWorkspace = emptyWorkspace();
  const remote = await f.library.generation.saveWorkspace(f.project.id, {
    ...staleWorkspace,
    shots: [newShot('remote', '外部编辑', { x: 4, y: 5 })],
  });
  const before = await readFile(f.database);
  await assert.rejects(
    f.library.generation.saveWorkspace(f.project.id, staleWorkspace),
    /其他窗口/,
  );
  assert.deepEqual(await readFile(f.database), before);
  assert.deepEqual(
    await f.library.generation.readWorkspace(f.project.id),
    remote,
  );
  const card = f.original.canvas.cards[0];
  assert.ok(card);
  await f.library.projects.patchCanvas(f.project.id, {
    before: [card],
    after: [{ ...card, position: { x: 77, y: 88 } }],
  });
  const edited = readProject(f.database);
  const latestBytes = await readFile(f.database);
  await assert.rejects(
    f.library.projects.patchCanvas(f.project.id, {
      before: [card],
      after: [{ ...card, position: { x: 99, y: 99 } }],
    }),
    /卡片已发生变化/,
  );
  assert.deepEqual(readProject(f.database), edited);
  assert.deepEqual(await readFile(f.database), latestBytes);
});
