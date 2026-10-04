import assert from 'node:assert/strict';
import {
  type FileHandle,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import type { encodeSequence } from '../src/main/export/encode-sequence';
import type { probeExportMedia } from '../src/main/export/media-probe';
import { SequenceExportService } from '../src/main/export/sequence-export-service';
import { fingerprint } from '../src/main/storage/files';
import { Library } from '../src/main/storage/library';
import { exportIsActive, type SequenceExportJob } from '../src/shared/export';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Media = { probe: typeof probeExportMedia; encode: typeof encodeSequence };
const fakeMedia: Media = {
  probe: async () => ({ duration: 1, width: 64, height: 64, hasAudio: true }),
  encode: async (_clips, _dimensions, _options, work, signal) => {
    signal.throwIfAborted();
    const file = await work.create('mp4');
    await writeFile(file, 'synthetic encoded output');
    return file;
  },
};

async function fixture(
  t: TestContext,
  media: Media = fakeMedia,
  changed: (job: SequenceExportJob) => void = () => {},
) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-export-preparation-')),
  );
  const data = join(base, 'app');
  const library = await Library.open(data, join(base, 'projects'));
  const { project } = await library.projects.create('取消准备');
  const bytes = Buffer.alloc(2 * 1024 * 1024, 90);
  await library.acceptResult(
    {
      projectId: project.id,
      resultKey: 'video',
      name: 'source.mp4',
      kind: 'video',
      extension: 'mp4',
    },
    Readable.from(bytes),
  );
  await library.saves.idle();
  const snapshot = await library.projects.open(project.id);
  const card = snapshot.canvas.cards[0];
  const asset = snapshot.assets[0];
  assert.ok(card && asset);
  const source = join(library.store.root, project.folder, asset.relativePath);
  const service = new SequenceExportService(
    library.projects,
    library.gate,
    library.store,
    data,
    () => {
      const job = service.list()[0];
      if (job) changed(job);
    },
    media,
  );
  t.after(async () => {
    await service.close();
    await library.close();
    await rm(base, { recursive: true, force: true });
  });
  return { base, data, library, project, card, asset, source, bytes, service };
}

async function finish(service: SequenceExportService, id: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const job = service.get(id);
    if (!exportIsActive(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('export did not settle');
}

test('cancel preparation before a job exists prevents late start and remains reusable', {
  timeout: 5_000,
}, async (t) => {
  const f = await fixture(t);
  const oldVersion = f.service.cancellationVersion;
  const target = join(f.base, 'cancelled.mp4');
  const starting = f.service.start(f.project.id, f.card.id, target);
  const rejected = assert.rejects(starting, { name: 'AbortError' });
  await f.service.cancelPreparation();
  await rejected;
  assert.notEqual(
    f.service.cancellationVersion,
    oldVersion,
    'native selections made before cancellation must be stale',
  );
  assert.deepEqual(f.service.list(), []);
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  const job = await f.service.start(
    f.project.id,
    f.card.id,
    join(f.base, 'retry.mp4'),
  );
  assert.equal((await finish(f.service, job.id)).status, 'completed');
  assert.deepEqual(await readFile(f.source), f.bytes);
});

test('cancellation during the first job notification waits for that attempt cleanup before a retry', {
  timeout: 5_000,
}, async (t) => {
  let cancelling: Promise<void> | undefined;
  const f = await fixture(t, fakeMedia, (job) => {
    if (job.status === 'preparing' && !cancelling)
      cancelling = f.service.cancelPreparation();
  });
  const target = join(f.base, 'retry.mp4');
  const job = await f.service.start(f.project.id, f.card.id, target);
  await cancelling;
  assert.equal(f.service.get(job.id).status, 'cancelled');
  const retry = await f.service.start(f.project.id, f.card.id, target);
  assert.equal((await finish(f.service, retry.id)).status, 'completed');
});

test('a cancelled start already queued for the write gate never reads a project or creates a job', {
  timeout: 5_000,
}, async (t) => {
  const f = await fixture(t);
  const release = deferred();
  const entered = deferred();
  const holding = f.library.gate.run(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const queued = deferred();
  const run = f.library.gate.run.bind(f.library.gate);
  t.mock.method(f.library.gate, 'run', <T>(operation: () => Promise<T>) => {
    const task = run(operation);
    queued.resolve();
    return task;
  });
  const originalOpen = f.library.projects.open.bind(f.library.projects);
  const opens = t.mock.method(f.library.projects, 'open', originalOpen);
  const starting = f.service.start(
    f.project.id,
    f.card.id,
    join(f.base, 'cancelled.mp4'),
  );
  const rejected = assert.rejects(starting, { name: 'AbortError' });
  await queued.promise;
  const cancelled = f.service.cancelPreparation();
  const saved = f.library.projects.update(f.project.id, {
    name: '排队保存成功',
  });
  release.resolve();
  await Promise.all([holding, rejected, cancelled, saved]);
  assert.equal(opens.mock.callCount(), 0);
  assert.deepEqual(f.service.list(), []);
  assert.equal((await originalOpen(f.project.id)).project.name, '排队保存成功');
  const job = await f.service.start(
    f.project.id,
    f.card.id,
    join(f.base, 'retry.mp4'),
  );
  assert.equal((await finish(f.service, job.id)).status, 'completed');
});

test('cancellation while the initial project read is pending cannot create a late job', {
  timeout: 5_000,
}, async (t) => {
  const f = await fixture(t);
  const entered = deferred();
  const release = deferred();
  const read = f.library.projects.open.bind(f.library.projects);
  t.mock.method(f.library.projects, 'open', async (id: string) => {
    const snapshot = await read(id);
    entered.resolve();
    await release.promise;
    return snapshot;
  });
  const starting = f.service.start(
    f.project.id,
    f.card.id,
    join(f.base, 'cancelled.mp4'),
  );
  const rejected = assert.rejects(starting, { name: 'AbortError' });
  await entered.promise;
  const cancelling = f.service.cancelPreparation();
  release.resolve();
  await Promise.all([cancelling, rejected]);
  assert.deepEqual(f.service.list(), []);
  assert.deepEqual(await readFile(f.source), f.bytes);
});

test('preparation waiting for migration admission cancels without waiting for the gate to reopen', {
  timeout: 5_000,
}, async (t) => {
  let block: Promise<void> | undefined;
  const f = await fixture(t, fakeMedia, (job) => {
    if (job.status === 'preparing' && !block) block = f.library.gate.block();
  });
  t.after(() => f.library.gate.release());
  const job = await f.service.start(
    f.project.id,
    f.card.id,
    join(f.base, 'cancelled.mp4'),
  );
  await block;
  assert.equal(f.library.gate.isBlocked, true);
  await f.service.cancelPreparation();
  assert.equal(f.service.get(job.id).status, 'cancelled');
  assert.equal(
    f.library.gate.isBlocked,
    true,
    'cancellation must not reopen migration admission',
  );
  assert.deepEqual(f.library.store.get('exportWork') ?? [], []);
  f.library.gate.release();
  await f.library.projects.update(f.project.id, { name: '准备取消后可保存' });
});

test('cancel preparation interrupts a multi-chunk hash and releases queued draft saves without reading the whole file', {
  timeout: 5_000,
}, async (t) => {
  const f = await fixture(t);
  const before = await fingerprint(f.source);
  const handle = await open(f.source, 'r');
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  const createStream = handle.createReadStream;
  await handle.close();
  const hashing = deferred();
  let readBytes = 0;
  let cancelled: Promise<void> | undefined;
  let saved: Promise<void> | undefined;
  const streams = t.mock.method(
    prototype,
    'createReadStream',
    function (
      this: FileHandle,
      options?: Parameters<FileHandle['createReadStream']>[0],
    ) {
      const stream = createStream.call(this, options);
      if (options?.signal)
        stream.on('data', (chunk) => {
          readBytes += chunk.length;
          if (cancelled) return;
          saved = f.library.projects.update(f.project.id, {
            name: '哈希取消后保存成功',
          });
          cancelled = f.service.cancelPreparation();
          hashing.resolve();
        });
      return stream;
    },
  );
  const target = join(f.base, 'cancelled.mp4');
  const job = await f.service.start(f.project.id, f.card.id, target);
  await hashing.promise;
  await Promise.all([cancelled, saved]);
  streams.mock.restore();
  assert.ok(
    readBytes > 0 && readBytes < f.bytes.length,
    `hash read ${readBytes} of ${f.bytes.length} bytes`,
  );
  assert.equal(f.service.get(job.id).status, 'cancelled');
  assert.equal(
    (await f.library.projects.open(f.project.id)).project.name,
    '哈希取消后保存成功',
  );
  assert.deepEqual(await readdir(join(f.data, 'export-work')), []);
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  assert.deepEqual(await fingerprint(f.source), before);
  const retry = await f.service.start(f.project.id, f.card.id, target);
  assert.equal((await finish(f.service, retry.id)).status, 'completed');
});

test('cancel preparation leaves encoding and final publication running, including repeated leave attempts', {
  timeout: 5_000,
}, async (t) => {
  const encoding = deferred<AbortSignal>();
  const release = deferred();
  let finalizing: Promise<void> | undefined;
  const media: Media = {
    ...fakeMedia,
    encode: async (...args) => {
      encoding.resolve(args[4]);
      await release.promise;
      return fakeMedia.encode(...args);
    },
  };
  const f = await fixture(t, media, (job) => {
    if (job.status === 'finalizing') finalizing = f.service.cancelPreparation();
  });
  const target = join(f.base, 'continued.mp4');
  const job = await f.service.start(f.project.id, f.card.id, target);
  const signal = await encoding.promise;
  await f.service.cancelPreparation();
  await f.service.cancelPreparation();
  assert.equal(signal.aborted, false);
  await f.library.projects.update(f.project.id, { name: '编码时仍可保存' });
  release.resolve();
  assert.equal((await finish(f.service, job.id)).status, 'completed');
  await finalizing;
  await f.service.cancelPreparation();
  assert.equal(await readFile(target, 'utf8'), 'synthetic encoded output');
  assert.deepEqual(await readFile(f.source), f.bytes);
});
