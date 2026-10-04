import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import { importReferenceFiles } from '../src/main/generation/import-references';
import { recordAsset } from '../src/main/projects/project-database';
import { publishCopy } from '../src/main/storage/files';
import { Library } from '../src/main/storage/library';
import type { Asset } from '../src/shared/models';

async function fixture(t: TestContext) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-project-recovery-')),
  );
  const app = join(base, 'app');
  const root = join(base, '项目 库');
  const library = await Library.open(app, root);
  t.after(async () => {
    t.mock.restoreAll();
    await library.close();
    await rm(base, { recursive: true, force: true });
  });
  const { project } = await library.projects.create('恢复凭据');
  const source = async (name: string, text = `${name}：原文件保持不变 🎬`) => {
    const path = join(base, name);
    await writeFile(path, text);
    return { path, bytes: Buffer.from(text) };
  };
  const importFile = async (name: string, projectId = project.id) => {
    const file = await source(name);
    const result = await importReferenceFiles(library, projectId, [file.path]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.assetIds.length, 1);
    const id = result.assetIds[0];
    assert.ok(id);
    await library.saves.idle();
    assert.equal(library.store.job(id).status, 'saved');
    return { ...file, id };
  };
  return { base, app, root, library, project, source, importFile };
}

function ordered(assets: Asset[]) {
  return [...assets].sort((a, b) => a.id.localeCompare(b.id));
}

async function fileState(paths: string[]) {
  return Promise.all(
    paths.map(async (path) => ({
      path,
      bytes: await readFile(path),
      mtimeNs: (await lstat(path, { bigint: true })).mtimeNs,
    })),
  );
}

test('saved reference recovery proofs contain the complete committed asset and repeated reads leave databases and source files unchanged', async (t) => {
  const f = await fixture(t);
  const first = await f.importFile('第一段.txt');
  const second = await f.importFile('第二段.md');
  const expected = await f.library.projects.open(f.project.id);
  assert.deepEqual(
    expected.assets,
    [first, second].map((file, index) => ({
      id: file.id,
      name: index === 0 ? '第一段.txt' : '第二段.md',
      relativePath: `assets/text/${file.id}.${index === 0 ? 'txt' : 'md'}`,
      size: file.bytes.length,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
      kind: 'text',
      usage: 'reference',
    })),
  );
  const database = await f.library.projects.databasePath(f.project.id);
  const paths = [
    join(f.app, 'app.sqlite'),
    database,
    first.path,
    second.path,
    ...expected.assets.map((asset) =>
      join(dirname(database), asset.relativePath),
    ),
  ];
  const before = await fileState(paths);
  const directoryBefore = await readdir(dirname(database));
  const jobsBefore = f.library.store.jobs();
  for (let count = 0; count < 3; count++) {
    const read = await f.library.projects.readRecovery(f.project.id);
    assert.deepEqual(read.snapshot, expected);
    assert.deepEqual(
      ordered(read.savedReferenceAssets),
      ordered(expected.assets),
    );
  }
  assert.deepEqual(await fileState(paths), before);
  assert.deepEqual(await readdir(dirname(database)), directoryBefore);
  assert.deepEqual(f.library.store.jobs(), jobsBefore);
});

test('recovery evidence excludes ready, failed, cloud, other-project and incomplete historical job metadata without inventing proofs', async (t) => {
  const f = await fixture(t);
  const local = await f.importFile('完整本地.txt');
  const historical = await f.importFile('缺少历史路径.txt');
  const oldJob = f.library.store.job(historical.id);
  assert.ok(oldJob.outputRelativePath);
  const { outputRelativePath: _missing, ...withoutPath } = oldJob;
  f.library.store.putJob(withoutPath);
  const other = await f.library.projects.create('另一个项目');
  await f.importFile('另一项目.txt', other.project.id);
  for (const [key, usage] of [
    [`cloud:${randomUUID()}`, 'reference'],
    [`reference:${randomUUID()}`, undefined],
  ] as const) {
    const job = await f.library.acceptResult(
      {
        projectId: f.project.id,
        resultKey: key,
        name: '非本地参考.txt',
        kind: 'text',
        extension: 'txt',
        ...(usage ? { usage } : {}),
      },
      Readable.from('complete non-local result'),
    );
    await f.library.saves.idle();
    assert.equal(f.library.store.job(job.id).status, 'saved');
  }
  // The project transaction can commit before its application-store acknowledgement
  // fails. Even that complete asset must not turn a failed job into a saved proof.
  const acknowledgementFile = await f.source('确认失败.txt');
  const acknowledgement = t.mock.method(f.library.store, 'putProject', () => {
    throw new Error('injected application acknowledgement failure');
  });
  const acknowledgementResult = await importReferenceFiles(
    f.library,
    f.project.id,
    [acknowledgementFile.path],
  );
  await f.library.saves.idle();
  acknowledgement.mock.restore();
  const unacknowledged = f.library.store.job(
    acknowledgementResult.assetIds[0] ?? '',
  );
  assert.equal(unacknowledged.status, 'failed');
  assert.match(unacknowledged.error ?? '', /application acknowledgement/);
  assert.ok(unacknowledged.sha256);
  assert.ok(unacknowledged.outputRelativePath);
  // Receive directly into the real staging area without starting the save queue.
  const ready = await f.library.staging.receive(
    {
      projectId: f.project.id,
      resultKey: `reference:${randomUUID()}`,
      name: '尚未提交.txt',
      kind: 'text',
      extension: 'txt',
      usage: 'reference',
    },
    Readable.from('protected complete bytes'),
  );
  const failed = await f.library.staging.receive(
    {
      projectId: f.project.id,
      resultKey: `reference:${randomUUID()}`,
      name: '接收失败.txt',
      kind: 'text',
      extension: 'txt',
      usage: 'reference',
    },
    Readable.from([]),
  );
  assert.equal(ready.status, 'ready');
  assert.equal(failed.status, 'failed');
  const jobsBefore = f.library.store.jobs();
  const read = await f.library.projects.readRecovery(f.project.id);
  assert.equal(read.snapshot.assets.length, 5);
  assert.deepEqual(read.savedReferenceAssets, [read.snapshot.assets[0]]);
  assert.equal(read.savedReferenceAssets[0]?.id, local.id);
  assert.ok(read.snapshot.assets.some((asset) => asset.id === historical.id));
  assert.ok(
    read.snapshot.assets.some((asset) => asset.id === unacknowledged.id),
  );
  assert.deepEqual(f.library.store.jobs(), jobsBefore);
  assert.equal(
    f.library.store.job(historical.id).outputRelativePath,
    undefined,
  );
  assert.equal(
    await readFile(f.library.staging.path(ready.id), 'utf8'),
    'protected complete bytes',
  );
  assert.equal(
    (await lstat(join(f.library.staging.directory, `${failed.id}.part`))).size,
    0,
  );
});

test('moving the library keeps saved reference proofs, project contents and source bytes intact', async (t) => {
  const f = await fixture(t);
  const imported = await f.importFile('迁移参考.txt');
  const before = await f.library.projects.readRecovery(f.project.id);
  const jobs = f.library.store.jobs();
  const database = await f.library.projects.databasePath(f.project.id);
  const databaseBytes = await readFile(database);
  const target = join(f.base, '新项目 库');
  await mkdir(target);
  const preview = await f.library.migration.prepare(target);
  await f.library.migration.start(preview.token);
  await f.library.migration.idle();
  await f.library.saves.idle();
  assert.equal(f.library.migration.journal?.status.phase, 'completed');
  assert.equal(f.library.store.root, target);
  assert.deepEqual(await f.library.projects.readRecovery(f.project.id), before);
  assert.deepEqual(f.library.store.jobs(), jobs);
  const moved = await f.library.projects.databasePath(f.project.id);
  assert.notEqual(moved, database);
  assert.deepEqual(await readFile(moved), databaseBytes);
  assert.deepEqual(await readFile(imported.path), imported.bytes);
  const asset = before.snapshot.assets[0];
  assert.ok(asset);
  assert.deepEqual(
    await readFile(join(dirname(moved), asset.relativePath)),
    imported.bytes,
  );
});

test('an imported package keeps original assets without borrowing proofs, then receives proofs only for its own new reference imports', async (t) => {
  const f = await fixture(t);
  const original = await f.importFile('项目包原素材.txt');
  const originalRead = await f.library.projects.readRecovery(f.project.id);
  const packagePath = join(f.base, '项目备份.afflatus');
  await f.library.packages.export(f.project.id, packagePath);
  const archiveBefore = await fileState([packagePath]);
  const imported = await f.library.packages.import(packagePath);
  assert.notEqual(imported.project.id, f.project.id);
  assert.deepEqual(imported.assets, originalRead.snapshot.assets);
  assert.deepEqual(await f.library.projects.readRecovery(imported.project.id), {
    snapshot: imported,
    savedReferenceAssets: [],
  });
  const own = await f.importFile('副本新素材.txt', imported.project.id);
  const read = await f.library.projects.readRecovery(imported.project.id);
  assert.deepEqual(read.snapshot.assets.slice(0, 1), imported.assets);
  assert.equal(read.snapshot.assets[1]?.id, own.id);
  assert.deepEqual(read.savedReferenceAssets, [read.snapshot.assets[1]]);
  assert.deepEqual(
    await f.library.projects.readRecovery(f.project.id),
    originalRead,
  );
  assert.deepEqual(await fileState([packagePath]), archiveBefore);
  const database = await f.library.projects.databasePath(imported.project.id);
  const originalAsset = imported.assets[0];
  assert.ok(originalAsset);
  assert.deepEqual(
    await readFile(join(dirname(database), originalAsset.relativePath)),
    original.bytes,
  );
  assert.deepEqual(await readFile(original.path), original.bytes);
  assert.deepEqual(await readFile(own.path), own.bytes);
});

test('a durable save scheduled at the SQLite asset-read boundary cannot supply newer proofs for the older snapshot', {
  timeout: 10_000,
}, async (t) => {
  const f = await fixture(t);
  await f.importFile('已确认.txt');
  const before = await f.library.projects.readRecovery(f.project.id);
  const pause = f.library.saves.pauseLocalReferences();
  const pendingFile = await f.source('边界提交.txt');
  const result = await importReferenceFiles(f.library, f.project.id, [
    pendingFile.path,
  ]);
  assert.deepEqual(result.errors, []);
  const pending = f.library.store.job(result.assetIds[0] ?? '');
  assert.equal(pending.status, 'ready');
  const database = await f.library.projects.databasePath(f.project.id);
  const asset: Asset = {
    id: pending.id,
    name: pending.name,
    relativePath: `assets/text/${pending.id}.txt`,
    size: pendingFile.bytes.length,
    sha256: createHash('sha256').update(pendingFile.bytes).digest('hex'),
    kind: 'text',
    usage: 'reference',
  };
  await publishCopy(
    pendingFile.path,
    join(dirname(database), asset.relativePath),
  );
  let resolveCommit!: () => void;
  let rejectCommit!: (error: unknown) => void;
  const committed = new Promise<void>((resolve, reject) => {
    resolveCommit = resolve;
    rejectCommit = reject;
  });
  let armed = true;
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (sql !== 'SELECT payload FROM assets ORDER BY rowid') return statement;
      const all = statement.all.bind(statement);
      t.mock.method(statement, 'all', () => {
        const rows = all();
        if (armed) {
          armed = false;
          // A real, synchronous project/app SQLite commit is ready at this exact
          // read boundary. Any await before collecting proofs would mix versions.
          queueMicrotask(() => {
            try {
              f.library.store.putProject(
                recordAsset(database, pending.resultKey, asset, f.project),
              );
              f.library.store.putJob({
                ...pending,
                status: 'saved',
                outputRelativePath: asset.relativePath,
              });
              resolveCommit();
            } catch (error) {
              rejectCommit(error);
            }
          });
        }
        return rows;
      });
      return statement;
    },
  );
  const [during] = await Promise.all([
    f.library.projects.readRecovery(f.project.id),
    committed,
  ]);
  assert.equal(armed, false, 'the native SQLite read boundary was reached');
  assert.deepEqual(
    during,
    before,
    'the first response must contain one coherent version',
  );
  const after = await f.library.projects.readRecovery(f.project.id);
  assert.deepEqual(after.snapshot.assets, [...before.snapshot.assets, asset]);
  assert.deepEqual(
    ordered(after.savedReferenceAssets),
    ordered(after.snapshot.assets),
  );
  assert.deepEqual(await readFile(pendingFile.path), pendingFile.bytes);
  pause.resume();
});
