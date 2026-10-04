import assert from 'node:assert/strict';
import fs, {
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import {
  type GeneratedResult,
  STAGING_CANCELLED,
  type StagingProgress,
} from '../src/main/saving/staging';
import { Library } from '../src/main/storage/library';

async function fixture(t: TestContext) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-receive-cancel-')),
  );
  const library = await Library.open(join(base, 'app'), join(base, 'projects'));
  const { project } = await library.projects.create('可取消接收');
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await library.close();
    await rm(base, { recursive: true, force: true });
  });
  const result = (key: string): GeneratedResult => ({
    projectId: project.id,
    resultKey: `reference:${key}`,
    name: `${key}.txt`,
    kind: 'text',
    usage: 'reference',
    extension: 'txt',
  });
  return { base, library, result };
}

test('a queued cancellation settles immediately and its later turn creates no job or file', {
  timeout: 5000,
}, async (t) => {
  const f = await fixture(t);
  const first = new PassThrough();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const receiving = f.library.staging.receive(f.result('first'), first, {
    onProgress: () => entered(),
  });
  await started;
  const second = new PassThrough();
  const controller = new AbortController();
  const queued = f.library.staging.receive(f.result('queued'), second, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  assert.equal(second.destroyed, true);
  assert.equal(f.library.store.jobs().length, 1);
  first.end('完整首文件');
  const accepted = await receiving;
  await f.library.staging.idle();
  assert.equal(accepted.status, 'ready');
  assert.deepEqual(await readdir(f.library.staging.directory), [
    `${accepted.id}.ready`,
  ]);
  assert.equal(f.library.store.jobs().length, 1);
});

test('cancel during receiving waits for the file handle and retains exactly the reported bytes', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const stream = new PassThrough();
  const progress: StagingProgress[] = [];
  const pending = f.library.staging.receive(f.result('partial'), stream, {
    signal: controller.signal,
    onProgress: (value) => {
      progress.push(value);
      if (value.bytes > 0) controller.abort();
    },
  });
  const bytes = Buffer.alloc(96 * 1024, 51);
  stream.write(bytes);
  const job = await pending;
  assert.equal(job.status, 'failed');
  assert.equal(job.error, STAGING_CANCELLED);
  assert.equal(stream.destroyed, true);
  const part = join(f.library.staging.directory, `${job.id}.part`);
  assert.deepEqual(await readFile(part), bytes.subarray(0, job.size));
  assert.ok(job.size > 0);
  assert.equal(progress.at(-1)?.bytes, job.size);
  assert.ok(progress.every((value) => value.phase === 'receiving'));
  await assert.rejects(readFile(f.library.staging.path(job.id)), {
    code: 'ENOENT',
  });
  // The receive result is not released while its file handle is still open.
  const handle = await open(part, 'r+');
  await handle.close();
  await f.library.staging.recover();
  assert.equal(f.library.store.job(job.id).status, 'failed');
  assert.deepEqual(await readFile(part), bytes.subarray(0, job.size));
});

test('cancellation during finalizing retains a failed part, while late ready cancellation retains the accepted ID', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const phases: string[] = [];
  const before = await f.library.staging.receive(
    f.result('before-publication'),
    Readable.from('before'),
    {
      signal: controller.signal,
      onProgress: (value) => {
        phases.push(value.phase);
        if (value.phase === 'finalizing') controller.abort();
      },
    },
  );
  assert.equal(before.error, STAGING_CANCELLED);
  assert.ok(phases.includes('finalizing'));
  assert.equal(
    await readFile(
      join(f.library.staging.directory, `${before.id}.part`),
      'utf8',
    ),
    'before',
  );
  const late = new AbortController();
  const stop = f.library.subscribe(() => {
    if (
      f.library.store
        .jobs()
        .some(
          (job) =>
            job.resultKey === 'reference:after-publication' &&
            job.status === 'ready',
        )
    )
      late.abort();
  });
  const after = await f.library.staging.receive(
    f.result('after-publication'),
    Readable.from('after'),
    { signal: late.signal },
  );
  stop();
  assert.equal(late.signal.aborted, true);
  assert.equal(after.status, 'ready');
  assert.equal(after.error, null);
  assert.equal(
    await readFile(f.library.staging.path(after.id), 'utf8'),
    'after',
  );
  assert.ok(after.sha256);
});

test('a filesystem error is retained when cancellation arrives after it; progress observers cannot fail reception', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const probe = await open(join(f.base, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const fault = t.mock.method(prototype, 'sync', async () => {
    controller.abort();
    throw new Error('disk fsync fault');
  });
  const failed = await f.library.staging.receive(
    f.result('disk-error'),
    Readable.from('keep'),
    { signal: controller.signal },
  );
  fault.mock.restore();
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /disk fsync fault/);
  assert.notEqual(failed.error, STAGING_CANCELLED);
  const accepted = await f.library.staging.receive(
    f.result('observer-error'),
    Readable.from('safe'),
    {
      onProgress: () => {
        throw new Error('observer');
      },
    },
  );
  assert.equal(accepted.status, 'ready');
});

test('active cancellation does not settle before the staging file handle has closed', async (t) => {
  const f = await fixture(t);
  const originalOpen = fs.open;
  let reached!: () => void;
  let release!: () => void;
  const closing = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const allowed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = t.mock.method(
    fs,
    'open',
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith('.part')) {
        const originalClose = handle.close;
        t.mock.method(handle, 'close', async () => {
          reached();
          await allowed;
          await originalClose.call(handle);
        });
      }
      return handle;
    },
  );
  syncBuiltinESMExports();
  const controller = new AbortController();
  let settled = false;
  const pending = f.library.staging
    .receive(f.result('wait-close'), Readable.from('close before return'), {
      signal: controller.signal,
      onProgress: (value) => {
        if (value.bytes) controller.abort();
      },
    })
    .then((value) => {
      settled = true;
      return value;
    });
  try {
    await closing;
    assert.equal(settled, false);
  } finally {
    release();
  }
  assert.equal((await pending).error, STAGING_CANCELLED);
  delayed.mock.restore();
  syncBuiltinESMExports();
});

test('acknowledged staging cleanup preserves a file replaced after its fingerprint', async (t) => {
  const f = await fixture(t);
  const job = await f.library.staging.receive(
    f.result('replaced-cleanup'),
    Readable.from('original bytes'),
  );
  const file = f.library.staging.path(job.id);
  const originalLstat = fs.lstat;
  const replacement = t.mock.method(
    fs,
    'lstat',
    async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === file) {
        replacement.mock.restore();
        syncBuiltinESMExports();
        await rename(file, join(f.base, 'held-original'));
        await writeFile(file, 'unrelated replacement');
      }
      return originalLstat(...args);
    },
  );
  syncBuiltinESMExports();
  await assert.rejects(f.library.staging.remove(job), /已变化/);
  assert.equal(await readFile(file, 'utf8'), 'unrelated replacement');
  assert.equal(
    await readFile(join(f.base, 'held-original'), 'utf8'),
    'original bytes',
  );
});
