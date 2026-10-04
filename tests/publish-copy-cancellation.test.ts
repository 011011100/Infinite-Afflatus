import assert from 'node:assert/strict';
import fs, {
  type FileHandle,
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
import { type TestContext, test } from 'node:test';
import { publishCopy } from '../src/main/storage/files';

async function fixture(t: TestContext) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-publish-cancel-')),
  );
  const source = join(base, 'source');
  const target = join(base, 'target');
  const bytes = Buffer.alloc(256 * 1024, 83);
  await writeFile(source, bytes);
  const probe = await open(source, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(base, { recursive: true, force: true });
  });
  return { base, source, target, bytes, prototype };
}

test('cancelling a streaming copy closes handles and removes only its unpublished temporary', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const originalWrite = f.prototype.write;
  let copied = 0;
  t.mock.method(
    f.prototype,
    'write',
    async function (this: FileHandle, ...args: unknown[]) {
      const result = await originalWrite.apply(this, args);
      copied += result.bytesWritten;
      controller.abort();
      return result;
    },
  );
  await assert.rejects(publishCopy(f.source, f.target, controller.signal), {
    name: 'AbortError',
  });
  assert.ok(copied > 0 && copied < f.bytes.length);
  assert.deepEqual(await readdir(f.base), ['source']);
  assert.deepEqual(await readFile(f.source), f.bytes);
});

test('the FAT/exFAT fallback also stops streaming and preserves its unregistered target for safe retry', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let fallback = false;
  t.mock.method(fs, 'link', async () => {
    fallback = true;
    throw Object.assign(new Error('no hard links'), { code: 'ENOTSUP' });
  });
  syncBuiltinESMExports();
  const originalWrite = f.prototype.write;
  t.mock.method(
    f.prototype,
    'write',
    async function (this: FileHandle, ...args: unknown[]) {
      const result = await originalWrite.apply(this, args);
      if (fallback) controller.abort();
      return result;
    },
  );
  await assert.rejects(publishCopy(f.source, f.target, controller.signal), {
    name: 'AbortError',
  });
  assert.equal(fallback, true);
  const partial = await readFile(f.target);
  assert.ok(partial.length > 0 && partial.length < f.bytes.length);
  assert.deepEqual(partial, f.bytes.subarray(0, partial.length));
  assert.deepEqual(await readdir(f.base), ['source', 'target']);
  assert.deepEqual(await readFile(f.source), f.bytes);
  await assert.rejects(publishCopy(f.source, f.target), { code: 'EEXIST' });
  assert.deepEqual(await readFile(f.target), partial);
});

test('a late cancellation cannot remove an already linked target', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const originalLink = fs.link;
  t.mock.method(fs, 'link', async (source: string, target: string) => {
    await originalLink(source, target);
    controller.abort();
  });
  syncBuiltinESMExports();
  await publishCopy(f.source, f.target, controller.signal);
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(await readFile(f.target), f.bytes);
  assert.deepEqual(await readdir(f.base), ['source', 'target']);
});

test('the FAT/exFAT fallback copies all bytes from the beginning when not cancelled', async (t) => {
  const f = await fixture(t);
  t.mock.method(fs, 'link', async () => {
    throw Object.assign(new Error('no hard links'), { code: 'ENOTSUP' });
  });
  syncBuiltinESMExports();
  await publishCopy(f.source, f.target);
  assert.deepEqual(await readFile(f.target), f.bytes);
  assert.deepEqual(await readFile(f.source), f.bytes);
  assert.deepEqual(await readdir(f.base), ['source', 'target']);
});

test('cleanup does not unlink a temporary filename replaced by another file', async (t) => {
  const f = await fixture(t);
  let replaced = '';
  t.mock.method(fs, 'link', async (temporary: string) => {
    replaced = temporary;
    await rename(temporary, join(f.base, 'held-original'));
    await writeFile(temporary, 'unrelated user data');
    throw new Error('publication fault after external replacement');
  });
  syncBuiltinESMExports();
  await assert.rejects(publishCopy(f.source, f.target), /publication fault/);
  assert.equal(await readFile(replaced, 'utf8'), 'unrelated user data');
  assert.deepEqual(await readFile(f.source), f.bytes);
  await assert.rejects(readFile(f.target), { code: 'ENOENT' });
});
