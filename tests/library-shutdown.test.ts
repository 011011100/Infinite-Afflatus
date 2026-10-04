import assert from 'node:assert/strict';
import {
  type FileHandle,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Library } from '../src/main/storage/library';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('direct library close cancels a gate-owning scan before waiting for queued reference saves', async (t) => {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-shutdown-order-')),
  );
  const data = join(base, 'app');
  const root = join(base, 'projects');
  const library = await Library.open(data, root);
  const releaseRead = deferred();
  t.after(async () => {
    releaseRead.resolve();
    t.mock.restoreAll();
    await library.close();
    await rm(base, { recursive: true, force: true });
  });
  const { project } = await library.projects.create('关闭时的共享写入通道');
  const bytes = Buffer.alloc(512 * 1024, 81);
  const saved = await library.acceptResult(
    {
      projectId: project.id,
      resultKey: 'reference:existing',
      name: 'existing.txt',
      kind: 'text',
      usage: 'reference',
      extension: 'txt',
    },
    Readable.from(bytes),
  );
  await library.saves.idle();
  const queued = await library.staging.receive(
    {
      projectId: project.id,
      resultKey: 'reference:queued',
      name: 'queued.txt',
      kind: 'text',
      usage: 'reference',
      extension: 'txt',
    },
    Readable.from(bytes),
  );
  const snapshot = await library.projects.open(project.id);
  const source = join(
    root,
    project.folder,
    snapshot.assets[0]?.relativePath ?? 'missing',
  );
  const probe = await open(source, 'r');
  const prototype = Object.getPrototypeOf(probe);
  const originalRead = prototype.read;
  await probe.close();
  const enteredRead = deferred();
  let held = false;
  const read = t.mock.method(
    prototype,
    'read',
    async function (this: FileHandle, ...args: unknown[]) {
      if (!held) {
        held = true;
        enteredRead.resolve();
        await releaseRead.promise;
      }
      return originalRead.apply(this, args);
    },
  );
  let cancellationRequested = false;
  const originalCancel = library.health.cancel.bind(library.health);
  const cancel = t.mock.method(library.health, 'cancel', () => {
    cancellationRequested = true;
    originalCancel();
    // A controlled disk read returns as soon as cancellation has been signaled.
    // Its next real scan boundary observes the signal while still owning gate.
    releaseRead.resolve();
  });
  const scan = assert.rejects(
    library.health.scan(project.id, 'full'),
    /已取消/,
  );
  await enteredRead.promise;
  library.saves.kick();
  const closing = library.close();
  try {
    assert.equal(
      cancellationRequested,
      true,
      'all gate holders must receive cancellation before close waits on queued reference writes',
    );
  } finally {
    releaseRead.resolve();
  }
  await closing;
  await scan;
  read.mock.restore();
  cancel.mock.restore();
  assert.deepEqual(await readFile(source), bytes);
  assert.deepEqual(await readFile(library.staging.path(queued.id)), bytes);
  const reopened = await Library.open(data, root);
  try {
    await reopened.saves.idle();
    assert.equal(reopened.store.job(queued.id).status, 'saved');
    assert.deepEqual(
      (await reopened.projects.open(project.id)).assets
        .map((asset) => asset.id)
        .sort(),
      [saved.id, queued.id].sort(),
    );
    assert.deepEqual(await readFile(source), bytes);
  } finally {
    await reopened.close();
  }
});
