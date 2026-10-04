import assert from 'node:assert/strict';
import fs, {
  type FileHandle,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { LocalReferencePause } from '../src/main/saving/save-queue';
import { Library } from '../src/main/storage/library';

async function fixture(t: TestContext) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-save-pause-')),
  );
  const data = join(base, 'app');
  const root = join(base, 'projects');
  const library = await Library.open(data, root);
  const { project } = await library.projects.create('局部暂停保存');
  const bytes = Buffer.alloc(256 * 1024, 107);
  const stage = (key: string, usage?: 'reference') =>
    library.staging.receive(
      {
        projectId: project.id,
        resultKey: key,
        name: `${key.replaceAll(':', '-')}.txt`,
        kind: 'text',
        usage,
        extension: 'txt',
      },
      Readable.from(bytes),
    );
  const probe = await open(join(base, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await library.close();
    await rm(base, { recursive: true, force: true });
  });
  return { base, data, root, library, project, bytes, stage, prototype };
}

test('independent reference pauses leave cloud jobs running and only the last resume releases local jobs', async (t) => {
  const f = await fixture(t);
  const local = await f.stage('reference:local', 'reference');
  const cloud = await f.stage('cloud:reference', 'reference');
  const ordinary = await f.stage('reference:not-local-without-usage');
  const first = f.library.saves.pauseLocalReferences();
  const second = f.library.saves.pauseLocalReferences();
  f.library.saves.kick();
  await first.idle();
  await f.library.saves.idle();
  assert.equal(f.library.store.job(local.id).status, 'ready');
  assert.equal(f.library.store.job(cloud.id).status, 'saved');
  assert.equal(f.library.store.job(ordinary.id).status, 'saved');
  first.resume();
  first.resume();
  await f.library.saves.idle();
  assert.equal(f.library.store.job(local.id).status, 'ready');
  assert.deepEqual(await readFile(f.library.staging.path(local.id)), f.bytes);
  second.resume();
  await f.library.saves.idle();
  assert.equal(f.library.store.job(local.id).status, 'saved');
  assert.equal((await f.library.projects.open(f.project.id)).assets.length, 3);
  second.resume();
  await f.library.saves.idle();
  assert.equal((await f.library.projects.open(f.project.id)).assets.length, 3);
});

test('idle follows a new drain started when the last pause is released during prior drain completion', async (t) => {
  const f = await fixture(t);
  const job = await f.stage('reference:resume-between-drains', 'reference');
  const pause = f.library.saves.pauseLocalReferences();
  const originalJobs = f.library.store.jobs.bind(f.library.store);
  let releaseScheduled = false;
  t.mock.method(f.library.store, 'jobs', () => {
    const snapshot = originalJobs();
    if (!releaseScheduled) {
      releaseScheduled = true;
      // The current lookup still sees the pause, but its finally will see a
      // newly eligible ready job and start the next drain.
      queueMicrotask(() => pause.resume());
    }
    return snapshot;
  });
  let entered!: () => void;
  let release!: () => void;
  const committing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const allowed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const originalOpen = f.library.projects.open.bind(f.library.projects);
  const delayed = t.mock.method(
    f.library.projects,
    'open',
    async (id: string) => {
      entered();
      await allowed;
      return originalOpen(id);
    },
  );
  f.library.saves.kick();
  let idleReturned = false;
  const idle = f.library.saves.idle().then(() => {
    idleReturned = true;
  });
  try {
    await committing;
    await setImmediate();
    assert.equal(
      idleReturned,
      false,
      'idle must include the replacement drain holding the write gate',
    );
  } finally {
    release();
  }
  await idle;
  delayed.mock.restore();
  assert.equal(f.library.store.job(job.id).status, 'saved');
  assert.deepEqual(
    (await f.library.projects.open(f.project.id)).assets.map(
      (asset) => asset.id,
    ),
    [job.id],
  );
  await assert.rejects(readFile(f.library.staging.path(job.id)), {
    code: 'ENOENT',
  });
});

for (const phase of ['hashing', 'copying'] as const) {
  test(`pausing active ${phase} releases the gate, retains ready bytes/path, and resumes once`, async (t) => {
    const f = await fixture(t);
    const job = await f.stage('reference:active', 'reference');
    let pause: LocalReferencePause | undefined;
    if (phase === 'hashing') {
      const original = f.prototype.createReadStream;
      t.mock.method(
        f.prototype,
        'createReadStream',
        function (this: FileHandle, options: object) {
          const stream = original.call(this, options);
          stream.once('data', () => {
            pause ??= f.library.saves.pauseLocalReferences();
          });
          return stream;
        },
      );
    } else {
      const original = f.prototype.write;
      t.mock.method(
        f.prototype,
        'write',
        async function (this: FileHandle, ...args: unknown[]) {
          const result = await original.apply(this, args);
          pause ??= f.library.saves.pauseLocalReferences();
          return result;
        },
      );
    }
    f.library.saves.kick();
    await f.library.saves.idle();
    assert.ok(pause);
    await pause.idle();
    await f.library.gate.run(async () => undefined);
    const paused = f.library.store.job(job.id);
    assert.equal(paused.status, 'ready');
    assert.equal(paused.error, null);
    assert.ok(paused.outputRelativePath);
    assert.equal(
      (await f.library.projects.open(f.project.id)).assets.length,
      0,
    );
    assert.deepEqual(await readFile(f.library.staging.path(job.id)), f.bytes);
    assert.deepEqual(
      await readdir(join(f.root, f.project.folder, 'assets', 'text')).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return [];
        },
      ),
      [],
    );
    t.mock.restoreAll();
    pause.resume();
    await f.library.saves.idle();
    const saved = f.library.store.job(job.id);
    assert.equal(saved.status, 'saved');
    assert.equal(saved.outputRelativePath, paused.outputRelativePath);
    const snapshot = await f.library.projects.open(f.project.id);
    assert.deepEqual(
      snapshot.assets.map((asset) => asset.id),
      [job.id],
    );
    assert.deepEqual(
      await readFile(join(f.root, f.project.folder, saved.outputRelativePath)),
      f.bytes,
    );
  });
}

test('a target published before pause remains intact and is adopted on resume without another asset', async (t) => {
  const f = await fixture(t);
  const job = await f.stage('reference:published', 'reference');
  let pause: LocalReferencePause | undefined;
  const originalLink = fs.link;
  const intercepted = t.mock.method(
    fs,
    'link',
    async (source: string, target: string) => {
      await originalLink(source, target);
      pause = f.library.saves.pauseLocalReferences();
    },
  );
  syncBuiltinESMExports();
  f.library.saves.kick();
  await f.library.saves.idle();
  assert.ok(pause);
  await pause.idle();
  const before = f.library.store.job(job.id);
  assert.equal(before.status, 'ready');
  assert.ok(before.outputRelativePath);
  const target = join(f.root, f.project.folder, before.outputRelativePath);
  assert.deepEqual(await readFile(target), f.bytes);
  assert.deepEqual(await readFile(f.library.staging.path(job.id)), f.bytes);
  assert.equal((await f.library.projects.open(f.project.id)).assets.length, 0);
  intercepted.mock.restore();
  syncBuiltinESMExports();
  pause.resume();
  await f.library.saves.idle();
  assert.equal(f.library.store.job(job.id).status, 'saved');
  assert.equal(
    f.library.store.job(job.id).outputRelativePath,
    before.outputRelativePath,
  );
  assert.deepEqual(
    (await f.library.projects.open(f.project.id)).assets.map(
      (asset) => asset.id,
    ),
    [job.id],
  );
  assert.deepEqual(await readFile(target), f.bytes);
});

test('pause after durable commit cancels staging cleanup without reverting saved; startup safely finishes cleanup', async (t) => {
  const f = await fixture(t);
  const job = await f.stage('reference:committed', 'reference');
  let pause: LocalReferencePause | undefined;
  const stop = f.library.subscribe(() => {
    if (f.library.store.job(job.id).status === 'saved')
      pause ??= f.library.saves.pauseLocalReferences();
  });
  f.library.saves.kick();
  await f.library.saves.idle();
  stop();
  assert.ok(pause);
  await pause.idle();
  await f.library.gate.run(async () => undefined);
  assert.equal(f.library.store.job(job.id).status, 'saved');
  assert.deepEqual(await readFile(f.library.staging.path(job.id)), f.bytes);
  const asset = (await f.library.projects.open(f.project.id)).assets[0];
  assert.ok(asset);
  pause.resume();
  await f.library.saves.idle();
  await f.library.close();
  const reopened = await Library.open(f.data, f.root);
  try {
    assert.equal(reopened.store.job(job.id).status, 'saved');
    assert.deepEqual((await reopened.projects.open(f.project.id)).assets, [
      asset,
    ]);
    await assert.rejects(readFile(reopened.staging.path(job.id)), {
      code: 'ENOENT',
    });
    assert.deepEqual(
      await readFile(join(f.root, f.project.folder, asset.relativePath)),
      f.bytes,
    );
  } finally {
    await reopened.close();
  }
});
