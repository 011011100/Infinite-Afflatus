import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { ArkConfigurationStore } from '../src/main/generation/ark-configuration';
import { ArkJournal } from '../src/main/generation/ark-journal';
import { ArkRequestError } from '../src/main/generation/ark-transport';
import {
  arkFixture,
  fakeSecrets,
  mockTransport,
  png,
} from './ark-generation-fixture';

async function submit(f: Awaited<ReturnType<typeof arkFixture>>) {
  const preview = await f.service.preview('window:1', f.target);
  return f.service.submit('window:1', preview.token);
}
test('image submission is one-use, exact, durable and adopts only into its shot', async (t) => {
  let posts = 0;
  let body: Record<string, unknown> | undefined;
  const f = await arkFixture(
    'image',
    mockTransport({
      createImage: async (request) => {
        posts++;
        body = request;
        return { url: 'https://fixture.invalid/result.png' };
      },
    }),
  );
  t.after(() => f.dispose());
  const preview = await f.service.preview('window:1', f.target);
  assert.equal(preview.modelId, 'doubao-seedream-5-0-260128');
  assert.equal(preview.imageSize, '2048x2048');
  assert.equal(preview.prompt, '测试提示词');
  assert.equal('request' in preview, false);
  await assert.rejects(
    f.service.submit('different-window', preview.token),
    /确认/,
  );
  const job = await f.service.submit('window:1', preview.token);
  assert.equal(job.phase, 'submitting');
  await assert.rejects(f.service.submit('window:1', preview.token), /确认/);
  const [candidate] = await f.settle();
  assert.equal(posts, 1);
  assert.equal(body?.sequential_image_generation, 'disabled');
  assert.equal(body?.model, preview.modelId);
  assert.equal(candidate?.phase, 'candidate');
  assert.equal('resultUrl' in (candidate ?? {}), false);
  const before = await f.library.projects.open(f.project.id);
  assert.equal(before.canvas.cards.length, 0);
  assert.equal(before.assets[0]?.usage, 'reference');
  const workspace = await f.library.generation.readWorkspace(f.project.id);
  const adopted = await f.service.adopt(job.id, workspace.revision);
  assert.equal(adopted.kind, 'image');
  assert.equal(adopted.workspace.revision, workspace.revision + 1);
  assert.equal(adopted.workspace.shots[0]?.nodes.length, 2);
  assert.deepEqual(adopted.snapshot.canvas, before.canvas);
  const again = await f.service.adopt(job.id, workspace.revision);
  assert.deepEqual(again, adopted);
  await f.restart();
  assert.equal(f.service.list(f.project.id)[0]?.phase, 'adopted');
  assert.equal(posts, 1);
});

test('changed workspace/bytes/config invalidate confirmation without submitting', async (t) => {
  let posts = 0;
  const f = await arkFixture(
    'image',
    mockTransport({
      createImage: async () => {
        posts++;
        return { url: 'https://fixture.invalid/result.png' };
      },
    }),
  );
  t.after(() => f.dispose());
  const preview = await f.service.preview(1, f.target);
  const workspace = await f.library.generation.readWorkspace(f.project.id);
  const shot = workspace.shots[0];
  const node = shot?.nodes[0];
  assert.ok(shot && node);
  shot.nodes[0] = {
    ...node,
    type: 'text',
    text: '已修改',
  };
  await f.library.generation.saveWorkspace(f.project.id, workspace);
  await assert.rejects(f.service.submit(1, preview.token), /变化/);
  assert.equal(posts, 0);
  const next = await f.service.preview(1, f.target);
  f.service.configure({ models: f.service.config().models });
  await assert.rejects(f.service.submit(1, next.token), /确认/);
  assert.equal(posts, 0);
});

test('ambiguous POST never retries after refresh, download retry or reopen', async (t) => {
  let posts = 0;
  const f = await arkFixture(
    'image',
    mockTransport({
      createImage: async () => {
        posts++;
        throw new ArkRequestError('未确认提交', true);
      },
    }),
  );
  t.after(() => f.dispose());
  const job = await submit(f);
  await f.settle();
  assert.equal(f.service.list(f.project.id)[0]?.phase, 'submission_unknown');
  await f.service.refresh(job.id);
  await f.service.retryDownload(job.id);
  await f.restart();
  await f.settle();
  const next = await f.service.preview(1, f.target);
  assert.ok(next.warnings.some((warning) => warning.includes('可能重复计费')));
  assert.equal(posts, 1);
  await f.service.submit(1, next.token);
  await f.settle();
  assert.equal(posts, 2);
  assert.equal(
    f.service
      .list(f.project.id)
      .filter((item) => item.phase === 'submission_unknown').length,
    2,
  );
});

test('download retry uses original result and does not regenerate; candidate stays hidden', async (t) => {
  let posts = 0;
  let downloads = 0;
  const f = await arkFixture(
    'image',
    mockTransport({
      createImage: async () => {
        posts++;
        return { url: 'https://fixture.invalid/result.png' };
      },
      download: async () => {
        downloads++;
        if (downloads === 1) throw new Error('fixture secret must not appear');
        return { stream: Readable.from(png()), extension: 'png' };
      },
    }),
  );
  t.after(() => f.dispose());
  const job = await submit(f);
  await f.settle();
  assert.equal(f.service.list(f.project.id)[0]?.phase, 'download_failed');
  assert.equal(
    f.service.list(f.project.id)[0]?.error?.includes('fixture secret'),
    false,
  );
  await f.service.retryDownload(job.id);
  const [candidate] = await f.settle();
  assert.equal(candidate?.phase, 'candidate');
  assert.equal(posts, 1);
  assert.equal(downloads, 2);
  assert.equal(
    (await f.library.projects.open(f.project.id)).canvas.cards.length,
    0,
  );
});

test('known video job resumes GET only and adopts a new card without changing prior trims', async (t) => {
  let posts = 0;
  let gets = 0;
  const f = await arkFixture(
    'video',
    mockTransport({
      createVideo: async () => {
        posts++;
        return { id: 'cgt-existing' };
      },
      getVideo: async () => {
        gets++;
        return {
          status: 'succeeded',
          url: 'https://fixture.invalid/result.mp4',
        };
      },
    }),
  );
  t.after(() => f.dispose());
  const old = await f.library.acceptResult(
    {
      projectId: f.project.id,
      resultKey: 'old-video',
      name: '旧视频',
      kind: 'video',
      extension: 'mp4',
    },
    Readable.from('old video'),
  );
  await f.library.saves.idle();
  const previous = await f.library.projects.open(f.project.id);
  const oldCard = previous.canvas.cards[0];
  assert.ok(oldCard);
  await f.library.projects.patchCanvas(f.project.id, {
    before: [oldCard],
    after: [{ ...oldCard, trims: { [old.id]: { start: 1, end: 3 } } }],
  });
  const before = await f.library.projects.open(f.project.id);
  const job = await submit(f);
  await f.service.idle();
  assert.equal(f.service.list(f.project.id)[0]?.phase, 'queued');
  await f.restart();
  await f.service.refresh(job.id);
  await f.settle();
  const ws = await f.library.generation.readWorkspace(f.project.id);
  const result = await f.service.adopt(job.id, ws.revision);
  assert.equal(posts, 1);
  assert.ok(gets >= 1);
  assert.equal(result.snapshot.canvas.revision, before.canvas.revision + 1);
  assert.deepEqual(result.snapshot.canvas.cards[0], before.canvas.cards[0]);
  assert.deepEqual(result.workspace.shots[0], ws.shots[0]);
  assert.equal(result.workspace.shots.length, 2);
  assert.equal(result.workspace.shots[1]?.sourceAssetId, result.assetId);
  assert.equal(
    result.snapshot.assets.find((asset) => asset.id === result.assetId)?.usage,
    undefined,
  );
  const duplicate = await f.service.adopt(job.id, ws.revision);
  assert.deepEqual(duplicate, result);
});

test('deleted group and stale adoption revision retain candidate unchanged', async (t) => {
  const f = await arkFixture();
  t.after(() => f.dispose());
  const job = await submit(f);
  await f.settle();
  const ws = await f.library.generation.readWorkspace(f.project.id);
  await assert.rejects(f.service.adopt(job.id, ws.revision - 1), /内容已变化/);
  ws.shots = [];
  await f.library.generation.saveWorkspace(f.project.id, ws);
  await assert.rejects(f.service.adopt(job.id, ws.revision + 1), /已移除/);
  assert.equal(f.service.list(f.project.id)[0]?.phase, 'candidate');
  assert.equal((await f.library.projects.open(f.project.id)).assets.length, 1);
});

test('secure configuration never returns plaintext and rejects plaintext backends', async (t) => {
  const f = await arkFixture();
  t.after(() => f.dispose());
  assert.equal(
    JSON.stringify(f.service.config()).includes('fixture-never'),
    false,
  );
  assert.equal(
    (await readFile(join(f.cloudData, 'ark-generation.sqlite'))).includes(
      Buffer.from('fixture-never-a-real-key'),
    ),
    false,
  );
  const journal = new ArkJournal(join(f.cloudData, 'other.sqlite'));
  t.after(() => journal.close());
  const config = new ArkConfigurationStore(journal, {
    ...fakeSecrets,
    getSelectedStorageBackend: () => 'basic_text',
  });
  assert.throws(
    () => config.save({ models: [], apiKey: 'fixture-not-a-key' }),
    /不允许明文/,
  );
  assert.equal(config.state().hasKey, false);
  assert.throws(
    () =>
      f.service.configure({
        models: [
          {
            alias: 'seedream-5.0-lite',
            capability: 'seedream-5.0-lite',
            modelId: 'doubao-seedream-5-0-pro-260628',
          },
        ],
      }),
    /能力版本/,
  );
});

test('cancel endpoint is never invoked; local stop and reopen preserve the remote task', async (t) => {
  const f = await arkFixture('video');
  t.after(() => f.dispose());
  const job = await submit(f);
  await f.service.idle();
  await assert.rejects(f.service.cancelQueued(job.id), /不能安全远端取消/);
  const stopped = await f.service.stopLocal(job.id);
  assert.equal(stopped.locallyStopped, true);
  assert.equal(stopped.remoteTaskId, 'cgt-fixture-task');
  await f.restart();
  assert.equal(f.service.list(f.project.id)[0]?.locallyStopped, true);
});

test('plain invalid cloud journal disables only cloud work', async (t) => {
  const f = await arkFixture();
  t.after(() => f.dispose());
  await f.service.close();
  await writeFile(join(f.cloudData, 'ark-generation.sqlite'), 'not SQLite');
  await f.restart();
  assert.match(f.service.config().error ?? '', /本地项目仍可使用/);
  assert.equal(
    (await f.library.projects.open(f.project.id)).project.id,
    f.project.id,
  );
  await assert.rejects(f.service.preview(1, f.target), /任务记录/);
});

test('expired image download permits only a separately reviewed and confirmed new paid attempt', async (t) => {
  let posts = 0;
  const f = await arkFixture(
    'image',
    mockTransport({
      createImage: async () => {
        posts++;
        return { url: 'https://fixture.invalid/expired-image' };
      },
      download: async () => {
        throw new Error('fixture expired result URL');
      },
    }),
  );
  t.after(() => f.dispose());
  const first = await submit(f);
  await f.settle();
  const old = f.service.list(f.project.id).find((job) => job.id === first.id);
  assert.equal(old?.phase, 'download_failed');
  const preview = await f.service.preview('window:1', f.target);
  assert.ok(
    preview.warnings.some(
      (warning) =>
        warning.includes('全新的付费生成请求') &&
        warning.includes('旧任务记录及已接收的文件继续保留'),
    ),
  );
  assert.equal(posts, 1);
  const next = await f.service.submit('window:1', preview.token);
  await f.settle();
  assert.notEqual(next.id, first.id);
  assert.equal(posts, 2);
  assert.deepEqual(
    f.service.list(f.project.id).find((job) => job.id === first.id),
    old,
  );
  await assert.rejects(f.service.submit('window:1', preview.token), /确认/);
  assert.equal(posts, 2);
});

test('active original-output download retry blocks a fresh generation preview', async (t) => {
  let downloads = 0;
  let release = () => {};
  let started = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const retryStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const original = mockTransport();
  const f = await arkFixture(
    'image',
    mockTransport({
      download: async (...args) => {
        downloads++;
        if (downloads === 1) throw new Error('fixture download failure');
        started();
        await waiting;
        return original.download(...args);
      },
    }),
  );
  t.after(() => f.dispose());
  t.after(() => release());
  const job = await submit(f);
  await f.settle();
  const retry = f.service.retryDownload(job.id);
  await retryStarted;
  await assert.rejects(f.service.preview('window:1', f.target), /已有未结束/);
  release();
  await retry;
  await f.settle();
});

test('idle save failure permits a fresh review but an active save retry blocks it', async (t) => {
  const f = await arkFixture();
  t.after(() => f.dispose());
  await f.library.gate.block();
  t.after(() => f.library.gate.release());
  const job = await submit(f);
  await f.service.idle();
  const saved = f.service.list(f.project.id)[0];
  assert.ok(saved?.saveJobId);
  const save = f.library.store.job(saved.saveJobId);
  save.status = 'failed';
  save.error = 'fixture save unavailable';
  f.library.store.putJob(save);
  assert.equal(f.service.list(f.project.id)[0]?.phase, 'save_failed');
  const preview = await f.service.preview('window:1', f.target);
  assert.ok(
    preview.warnings.some((warning) =>
      warning.includes('不是原结果的下载或保存重试'),
    ),
  );
  f.service.cancelPreview('window:1', preview.token);
  const originalRetry = f.library.saves.retry.bind(f.library.saves);
  let release = () => {};
  let started = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const retryStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.library.saves.retry = async (id) => {
    started();
    await waiting;
    return originalRetry(id);
  };
  t.after(() => release());
  const retry = f.service.retrySave(job.id);
  await retryStarted;
  assert.equal(f.service.list(f.project.id)[0]?.phase, 'save_failed');
  await assert.rejects(f.service.preview('window:1', f.target), /已有未结束/);
  release();
  await retry;
  f.library.gate.release();
  await f.settle();
});
