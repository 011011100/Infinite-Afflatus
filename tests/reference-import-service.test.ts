import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import type { ReferenceReceiver } from '../src/main/generation/import-references';
import { ReferenceImportService } from '../src/main/generation/reference-import-service';
import {
  type GeneratedResult,
  STAGING_CANCELLED,
} from '../src/main/saving/staging';
import type { ReferenceImportProgress } from '../src/shared/generation/reference-import';
import type { SaveJob } from '../src/shared/models';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixtures(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), 'afflatus-import-service-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const paths: [string, string, string] = [
    join(base, 'first.txt'),
    join(base, 'second.png'),
    join(base, 'third.txt'),
  ];
  await Promise.all(
    paths.map((file, index) =>
      writeFile(file, Buffer.alloc(index === 1 ? 256 * 1024 : 16, index + 1)),
    ),
  );
  return paths;
}

function job(
  result: GeneratedResult,
  status: SaveJob['status'] = 'ready',
  error: string | null = null,
): SaveJob {
  return {
    ...result,
    id: randomUUID(),
    status,
    size: 16,
    sha256: 'a'.repeat(64),
    error,
    createdAt: new Date().toISOString(),
  };
}

function pauses() {
  const handles: {
    pending: ReturnType<typeof deferred<void>>;
    resumed: number;
    idleCalls: number;
  }[] = [];
  return {
    handles,
    at(index: number) {
      const handle = handles[index];
      assert.ok(handle);
      return handle;
    },
    pauseLocalReferences() {
      const state = { pending: deferred<void>(), resumed: 0, idleCalls: 0 };
      handles.push(state);
      return {
        idle: () => {
          state.idleCalls += 1;
          return state.pending.promise;
        },
        resume: () => {
          state.resumed += 1;
        },
      };
    },
  };
}

const selection = (filePaths: string[]) => async () => ({
  canceled: false,
  filePaths,
});
const consume: ReferenceReceiver['acceptResult'] = async (
  result,
  stream,
  controls,
) => {
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    controls?.onProgress?.({ phase: 'receiving', bytes });
  }
  controls?.onProgress?.({ phase: 'finalizing', bytes });
  return { ...job(result), size: bytes };
};

test('chooser cancellation returns immediately, ignores its late files, and keeps other owners independent', async (t) => {
  const files = await fixtures(t);
  const chooser = deferred<{ canceled: boolean; filePaths: string[] }>();
  let received = 0;
  const service = new ReferenceImportService(
    {
      acceptResult: async (...args) => {
        received += 1;
        return consume(...args);
      },
    },
    pauses(),
  );
  const progress: ReferenceImportProgress[] = [];
  const projectId = randomUUID();
  const requestId = randomUUID();
  const pending = service.run(
    1,
    projectId,
    requestId,
    () => chooser.promise,
    (value) => progress.push(value),
  );
  await assert.rejects(
    service.run(1, projectId, randomUUID(), selection(files)),
    /已有素材/,
  );
  await service.cancel(2, requestId);
  await service.cancel(1, randomUUID());
  assert.equal(progress.at(-1)?.phase, 'choosing');
  const other = await service.run(
    2,
    projectId,
    randomUUID(),
    selection(files.slice(0, 1)),
  );
  assert.equal(other.assetIds.length, 1);
  await service.cancel(1, requestId);
  assert.deepEqual(await pending, {
    assetIds: [],
    errors: [],
    cancelled: true,
    cancelledCount: 0,
  });
  chooser.resolve({ canceled: false, filePaths: files });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(received, 1, 'late chooser must not read a single source');
  assert.deepEqual(
    progress.map((value) => value.phase),
    ['choosing', 'cancelling', 'cancelled'],
  );
  assert.ok(
    progress.every(
      (value) => value.requestId === requestId && value.projectId === projectId,
    ),
  );
  assert.equal(
    (await service.run(1, projectId, randomUUID(), selection(files.slice(2))))
      .assetIds.length,
    1,
  );
});

test('cancel waits for active intake cleanup, keeps prior successes/errors, and counts only current and unstarted files', async (t) => {
  const files = await fixtures(t);
  const started = deferred<void>();
  const cleanup = deferred<void>();
  let activeStream: Readable | undefined;
  let accepts = 0;
  const service = new ReferenceImportService(
    {
      acceptResult: async (result, stream, controls) => {
        accepts += 1;
        if (result.name !== 'second.png')
          return consume(result, stream, controls);
        activeStream = stream;
        started.resolve();
        await new Promise<void>((resolve) =>
          controls?.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        await cleanup.promise;
        return job(result, 'failed', STAGING_CANCELLED);
      },
    },
    pauses(),
  );
  const requestId = randomUUID();
  const pending = service.run(
    1,
    randomUUID(),
    requestId,
    selection([files[0], 'unsupported.pdf', files[1], files[2]]),
  );
  await started.promise;
  let settled = false;
  const cancellation = service.cancel(1, requestId).then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'abort must wait for receiver cleanup');
  cleanup.resolve();
  await cancellation;
  const result = await pending;
  assert.equal(result.assetIds.length, 1);
  assert.match(result.errors[0] ?? '', /unsupported.pdf.*不支持/);
  assert.equal(result.errors.length, 1);
  assert.equal(result.cancelled, true);
  assert.equal(result.cancelledCount, 2);
  assert.equal(accepts, 2);
  assert.equal(
    activeStream?.closed,
    true,
    'source handle is closed before cancellation resolves',
  );
});

test('a fully accepted file survives late cancellation while a prior non-cancel failure stays an error', async (t) => {
  const files = await fixtures(t);
  let service!: ReferenceImportService;
  const requestId = randomUUID();
  service = new ReferenceImportService(
    {
      acceptResult: async (result, stream, controls) => {
        const complete = await consume(result, stream, controls);
        void service.cancel(1, requestId);
        return complete;
      },
    },
    pauses(),
  );
  const result = await service.run(
    1,
    randomUUID(),
    requestId,
    selection(['unsupported.pdf', ...files]),
  );
  assert.equal(result.assetIds.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.cancelledCount, 2);
  assert.equal(result.cancelled, true);

  const failedId = randomUUID();
  service = new ReferenceImportService(
    {
      acceptResult: async (input) => {
        void service.cancel(1, failedId);
        return job(input, 'failed', '接收结果失败：磁盘错误');
      },
    },
    pauses(),
  );
  const failed = await service.run(1, randomUUID(), failedId, selection(files));
  assert.equal(
    failed.cancelledCount,
    2,
    'a non-cancel failure is not relabeled as a cancelled file',
  );
  assert.match(failed.errors[0] ?? '', /磁盘错误/);
});

test('leave pause is synchronous, drains its captured writer, and tokens resume independently only for their owner', async () => {
  const saves = pauses();
  const service = new ReferenceImportService({ acceptResult: consume }, saves);
  const choose = deferred<{ canceled: boolean; filePaths: string[] }>();
  const pending = service.run(
    1,
    randomUUID(),
    randomUUID(),
    () => choose.promise,
  );
  const first = service.prepareForLeave(1);
  assert.equal(
    saves.handles.length,
    1,
    'pause is acquired before the first await',
  );
  assert.equal((await pending).cancelled, true);
  assert.deepEqual(
    await service.run(1, randomUUID(), randomUUID(), async () => {
      assert.fail(
        'A request arriving after leave starts must not open a chooser',
      );
    }),
    { assetIds: [], errors: [], cancelled: true, cancelledCount: 0 },
  );
  let ready = false;
  void first.then(() => {
    ready = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(ready, false);
  saves.at(0).pending.resolve();
  const token1 = await first;
  const second = service.prepareForLeave(1);
  saves.at(1).pending.resolve();
  const token2 = await second;
  assert.notEqual(token1, token2);
  assert.throws(() => service.resumeAfterLeave(2, token1), /其他窗口/);
  service.resumeAfterLeave(1, token1);
  service.resumeAfterLeave(1, token1);
  assert.deepEqual(
    saves.handles.map((handle) => handle.resumed),
    [1, 0],
  );
  assert.equal(
    (
      await service.run(1, randomUUID(), randomUUID(), async () => {
        assert.fail(
          'The second independent leave token still blocks native selection',
        );
      })
    ).cancelled,
    true,
  );
  service.resumeOwner(2);
  assert.equal(saves.at(1).resumed, 0);
  service.resumeOwner(1);
  assert.equal(saves.at(1).resumed, 1);
  assert.equal(
    (await service.run(1, randomUUID(), randomUUID(), selection([]))).cancelled,
    false,
  );
});

test('close cancels all owners, waits for its pause, remains permanently paused and refuses new work', async () => {
  const saves = pauses();
  const service = new ReferenceImportService({ acceptResult: consume }, saves);
  const leave = service.prepareForLeave(1);
  saves.at(0).pending.resolve();
  const token = await leave;
  const selecting = service.run(
    2,
    randomUUID(),
    randomUUID(),
    () => new Promise(() => undefined),
  );
  const closing = service.close();
  assert.equal(service.close(), closing);
  assert.equal((await selecting).cancelled, true);
  await assert.rejects(
    service.run(3, randomUUID(), randomUUID(), selection([])),
    /关闭/,
  );
  service.resumeAfterLeave(1, token);
  service.resumeOwner(1);
  assert.deepEqual(
    saves.handles.map((handle) => handle.resumed),
    [0, 0],
  );
  saves.at(1).pending.resolve();
  await closing;
  assert.deepEqual(
    saves.handles.map((handle) => handle.resumed),
    [0, 0],
  );
});

test('progress reports actual received bytes with throttled updates, immediate stage changes and terminal counts', async (t) => {
  const files = await fixtures(t);
  const progress: ReferenceImportProgress[] = [];
  const service = new ReferenceImportService(
    { acceptResult: consume },
    pauses(),
  );
  const result = await service.run(
    1,
    randomUUID(),
    randomUUID(),
    selection(files.slice(1, 2)),
    (value) => progress.push(value),
  );
  assert.equal(result.assetIds.length, 1);
  assert.equal(progress[0]?.phase, 'choosing');
  assert.equal(progress.at(-1)?.phase, 'completed');
  const finalizing = progress.find((value) => value.phase === 'finalizing');
  assert.equal(finalizing?.receivedBytes, 256 * 1024);
  assert.equal(finalizing?.fileBytes, 256 * 1024);
  assert.equal(finalizing?.fileName, 'second.png');
  assert.equal(finalizing?.fileIndex, 1);
  assert.equal(progress.at(-1)?.acceptedCount, 1);
  assert.equal(progress.at(-1)?.failedCount, 0);
  assert.ok(
    progress.filter((value) => value.phase === 'receiving').length < 4,
    'four fast input chunks must not each emit progress',
  );
});

test('chooser failure releases the owner and an observer failure does not abort intake', async (t) => {
  const files = await fixtures(t);
  const service = new ReferenceImportService(
    { acceptResult: consume },
    pauses(),
  );
  const phases: string[] = [];
  await assert.rejects(
    service.run(
      1,
      randomUUID(),
      randomUUID(),
      async () => {
        throw new Error('chooser failed');
      },
      (value) => phases.push(value.phase),
    ),
    /chooser failed/,
  );
  assert.deepEqual(phases, ['choosing', 'completed']);
  const result = await service.run(
    1,
    randomUUID(),
    randomUUID(),
    selection(files.slice(0, 1)),
    () => {
      throw new Error('window destroyed');
    },
  );
  assert.equal(result.assetIds.length, 1);
});

test('cancelling before the first file opens counts every unstarted input and a late terminal cancel cannot regress progress', async (t) => {
  const files = await fixtures(t);
  let accepts = 0;
  const service = new ReferenceImportService(
    {
      acceptResult: async (...args) => {
        accepts += 1;
        return consume(...args);
      },
    },
    pauses(),
  );
  const requestId = randomUUID();
  const cancelled = await service.run(
    1,
    randomUUID(),
    requestId,
    selection(['unsupported.pdf', ...files]),
    (progress) => {
      if (progress.phase === 'receiving') void service.cancel(1, requestId);
    },
  );
  assert.deepEqual(cancelled, {
    assetIds: [],
    errors: [],
    cancelled: true,
    cancelledCount: 4,
  });
  assert.equal(accepts, 0);
  const completedId = randomUUID();
  const phases: string[] = [];
  const result = await service.run(
    1,
    randomUUID(),
    completedId,
    selection(files.slice(0, 1)),
    (progress) => {
      phases.push(progress.phase);
      if (progress.phase === 'completed') void service.cancel(1, completedId);
    },
  );
  assert.equal(result.cancelled, false);
  assert.equal(result.assetIds.length, 1);
  assert.equal(phases.at(-1), 'completed');
});
