import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { importReferenceFiles } from '../src/main/generation/import-references';
import { Library } from '../src/main/storage/library';
import { MAX_REFERENCES } from '../src/shared/generation/draft';
import { emptyWorkspace, newShot } from '../src/shared/generation/workspace';
import type { SaveJob } from '../src/shared/models';

async function fixture(t: TestContext, quota?: number) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-reference-import-')),
  );
  const app = join(base, 'app');
  const root = join(base, 'projects');
  const library = await Library.open(app, root, quota);
  t.after(async () => {
    await library.close();
    await rm(base, { recursive: true, force: true });
  });
  const { project } = await library.projects.create('部分导入仍可编辑');
  const file = async (name: string, content: string | Buffer) => {
    const path = join(base, name);
    await writeFile(path, content);
    return path;
  };
  return { base, app, root, library, project, file };
}

function workspaceWithReferences(ids: string[]) {
  const shot = newShot('shot', '继续编辑', { x: 100, y: 200 });
  shot.nodes = ids.map((assetId, index) => ({
    id: `reference-${index}`,
    type: 'asset',
    assetId,
    position: { x: index * 300, y: 100 },
  }));
  shot.nodes.push({
    id: 'text',
    type: 'text',
    text: '部分导入失败后继续输入，必须能够保存',
    position: { x: 100, y: 500 },
  });
  return { ...emptyWorkspace(), shots: [shot] };
}

test('empty, missing and unsupported files do not add invalid references or discard later successful imports', async (t) => {
  const f = await fixture(t);
  const first = await f.file('有效一.txt', '第一段中文');
  const empty = await f.file('空白.txt', '');
  const second = await f.file('有效二.md', '第二段中文 🎬');
  const result = await importReferenceFiles(f.library, f.project.id, [
    first,
    empty,
    join(f.base, '找不到.txt'),
    join(f.base, '不支持.pdf'),
    second,
  ]);
  await f.library.saves.idle();
  assert.equal(result.assetIds.length, 2);
  assert.equal(result.errors.length, 3);
  assert.match(result.errors[0] ?? '', /空白.txt.*为空/);
  assert.match(result.errors[1] ?? '', /找不到.txt/);
  assert.match(result.errors[2] ?? '', /不支持.pdf.*不支持/);
  const failed = f.library.store.jobs().find((job) => job.name === '空白.txt');
  assert.ok(failed);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.sha256, '');
  assert.ok(!result.assetIds.includes(failed.id));
  assert.equal(
    (await readFile(join(f.library.staging.directory, `${failed.id}.part`)))
      .length,
    0,
  );
  const wanted = workspaceWithReferences(result.assetIds);
  const saved = await f.library.generation.saveWorkspace(f.project.id, wanted);
  assert.deepEqual(saved, { ...wanted, revision: 1 });
  const snapshot = await f.library.projects.open(f.project.id);
  assert.deepEqual(
    snapshot.assets.map((asset) => asset.id).sort(),
    [...result.assetIds].sort(),
  );
  assert.equal(snapshot.canvas.cards.length, 0);
  assert.equal(await readFile(first, 'utf8'), '第一段中文');
  assert.equal(await readFile(second, 'utf8'), '第二段中文 🎬');
  assert.equal((await readFile(empty)).length, 0);
  await f.library.close();
  const reopened = await Library.open(f.app, f.root);
  try {
    assert.deepEqual(
      await reopened.generation.readWorkspace(f.project.id),
      saved,
    );
    assert.equal(reopened.store.job(failed.id).status, 'failed');
    assert.equal(
      (await readFile(join(reopened.staging.directory, `${failed.id}.part`)))
        .length,
      0,
    );
  } finally {
    await reopened.close();
  }
});

test('complete ready references remain usable before the project save queue commits them', async (t) => {
  const f = await fixture(t);
  const source = await f.file('迁移期间.txt', '迁移时完整暂存的引用');
  await f.library.gate.block();
  const result = await importReferenceFiles(f.library, f.project.id, [source]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.assetIds.length, 1);
  const id = result.assetIds[0];
  assert.ok(id);
  const job = f.library.store.job(id);
  assert.equal(job.status, 'ready');
  assert.ok(job.sha256);
  assert.deepEqual(
    await readFile(f.library.staging.path(id)),
    await readFile(source),
  );
  assert.equal((await f.library.projects.open(f.project.id)).assets.length, 0);
  f.library.gate.release();
  // Do not kick the save queue yet: its durable ID is already legal in a workspace.
  const wanted = workspaceWithReferences([id]);
  assert.deepEqual(
    await f.library.generation.saveWorkspace(f.project.id, wanted),
    {
      ...wanted,
      revision: 1,
    },
  );
  f.library.saves.kick();
  await f.library.saves.idle();
  assert.equal(f.library.store.job(id).status, 'saved');
  assert.deepEqual(
    (await f.library.projects.open(f.project.id)).assets.map(
      (asset) => asset.id,
    ),
    [id],
  );
});

test('quota failure retains the incomplete part and source bytes while later small imports still save', async (t) => {
  const f = await fixture(t, 96 * 1024);
  const first = await f.file('先导入.txt', 'first');
  const content = Buffer.alloc(200 * 1024, 37);
  const large = await f.file('超过暂存配额.png', content);
  const last = await f.file('后导入.txt', 'last');
  const result = await importReferenceFiles(f.library, f.project.id, [
    first,
    large,
    last,
  ]);
  await f.library.saves.idle();
  assert.equal(result.assetIds.length, 2);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? '', /超过暂存配额.png.*上限/);
  const failed = f.library.store
    .jobs()
    .find((job) => job.name === '超过暂存配额.png');
  assert.ok(failed);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.sha256, '');
  assert.ok(!result.assetIds.includes(failed.id));
  const partial = await readFile(
    join(f.library.staging.directory, `${failed.id}.part`),
  );
  assert.ok(partial.length > 0 && partial.length < content.length);
  assert.deepEqual(partial, content.subarray(0, partial.length));
  assert.deepEqual(await readFile(large), content);
  const wanted = workspaceWithReferences(result.assetIds);
  assert.deepEqual(
    await f.library.generation.saveWorkspace(f.project.id, wanted),
    {
      ...wanted,
      revision: 1,
    },
  );
  assert.equal(await readFile(first, 'utf8'), 'first');
  assert.equal(await readFile(last, 'utf8'), 'last');
});

test('an intake digest does not turn failed staging publication into an accepted reference', async (t) => {
  const f = await fixture(t);
  const source = await f.file(
    '发布失败.txt',
    'complete input, unpublished output',
  );
  const putJob = f.library.store.putJob.bind(f.library.store);
  t.mock.method(f.library.store, 'putJob', (job: SaveJob) => {
    putJob(job);
    if (job.status === 'receiving' && job.sha256)
      mkdirSync(f.library.staging.path(job.id));
  });
  const result = await importReferenceFiles(f.library, f.project.id, [source]);
  assert.deepEqual(result.assetIds, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? '', /发布失败.txt.*接收结果失败/);
  const job = f.library.store.jobs()[0];
  assert.ok(job);
  assert.equal(job.status, 'failed');
  assert.ok(job.sha256);
  assert.deepEqual(
    await readFile(join(f.library.staging.directory, `${job.id}.part`)),
    await readFile(source),
  );
  assert.equal((await f.library.projects.open(f.project.id)).assets.length, 0);
  const wanted = workspaceWithReferences([]);
  assert.deepEqual(
    await f.library.generation.saveWorkspace(f.project.id, wanted),
    {
      ...wanted,
      revision: 1,
    },
  );
});

test('the existing per-selection limit rejects before receiving any file', async (t) => {
  const f = await fixture(t);
  const source = await f.file('文本.txt', 'text');
  await assert.rejects(
    importReferenceFiles(
      f.library,
      f.project.id,
      Array(MAX_REFERENCES + 1).fill(source),
    ),
    /一次最多导入/,
  );
  assert.deepEqual(f.library.store.jobs(), []);
});

test('service cancellation preserves completed staging IDs, drains file handles and leaves the workspace writable before saved copies resume', async (t) => {
  const f = await fixture(t);
  const first = await f.file('已完成.txt', 'keep this complete reference');
  const bytes = Buffer.alloc(256 * 1024, 93);
  const current = await f.file('取消当前.png', bytes);
  const last = await f.file('未开始.txt', 'do not start this file');
  await f.library.gate.block();
  const requestId = crypto.randomUUID();
  let cancellation: Promise<void> | undefined;
  const result = await f.library.referenceImports.run(
    1,
    f.project.id,
    requestId,
    async () => ({ canceled: false, filePaths: [first, current, last] }),
    (progress) => {
      if (progress.fileIndex === 2 && progress.phase === 'finalizing')
        cancellation = f.library.referenceImports.cancel(1, requestId);
    },
  );
  assert.ok(cancellation);
  await cancellation;
  assert.equal(result.assetIds.length, 1);
  assert.equal(result.cancelled, true);
  assert.equal(result.cancelledCount, 2);
  assert.deepEqual(result.errors, []);
  assert.equal(
    f.library.store.jobs().length,
    2,
    'unstarted file has no save job',
  );
  const accepted = f.library.store.job(result.assetIds[0] ?? '');
  assert.equal(accepted.status, 'ready');
  assert.equal(
    await readFile(f.library.staging.path(accepted.id), 'utf8'),
    'keep this complete reference',
  );
  const cancelled = f.library.store
    .jobs()
    .find((job) => job.name === '取消当前.png');
  assert.ok(cancelled);
  assert.equal(cancelled.status, 'failed');
  assert.equal(cancelled.error, '接收结果已取消');
  assert.deepEqual(
    await readFile(join(f.library.staging.directory, `${cancelled.id}.part`)),
    bytes,
  );
  const token = await f.library.referenceImports.prepareForLeave(1);
  f.library.gate.release();
  const wanted = workspaceWithReferences(result.assetIds);
  const saved = await f.library.generation.saveWorkspace(f.project.id, wanted);
  assert.deepEqual(saved, { ...wanted, revision: 1 });
  assert.equal((await f.library.projects.open(f.project.id)).assets.length, 0);
  f.library.referenceImports.resumeAfterLeave(1, token);
  await f.library.saves.idle();
  assert.equal(f.library.store.job(accepted.id).status, 'saved');
  assert.equal((await f.library.projects.open(f.project.id)).assets.length, 1);
  assert.deepEqual(await readFile(current), bytes);
  assert.equal(await readFile(last, 'utf8'), 'do not start this file');
});
