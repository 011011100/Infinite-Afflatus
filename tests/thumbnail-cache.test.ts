import assert from 'node:assert/strict';
import test from 'node:test';
import { ThumbnailCache } from '../src/renderer/src/features/workspace/thumbnail-cache';

test('regrouping and undo reuse the same decoded frame, including in-flight loads', async () => {
  const cache = new ThumbnailCache<object>();
  const frame = { duration: 4 };
  let decodes = 0;
  const decode = async () => {
    decodes++;
    return frame;
  };
  const original = cache.load('project/asset/hash', decode);
  const regrouped = cache.load('project/asset/hash', decode);
  assert.equal(original, regrouped);
  assert.equal(await original, frame);
  // A new thumbnail gets its first paint synchronously, before effects run.
  assert.equal(cache.get('project/asset/hash'), frame);
  assert.equal(await cache.load('project/asset/hash', decode), frame);
  assert.equal(decodes, 1);
  assert.equal(cache.get('another-project/asset/hash'), undefined);
  assert.equal(cache.get('project/asset/new-hash'), undefined);
});

test('failed decodes can be retried instead of caching an empty frame', async () => {
  const cache = new ThumbnailCache<string>();
  await assert.rejects(
    cache.load('asset', async () => {
      throw new Error('unavailable');
    }),
  );
  assert.equal(cache.get('asset'), undefined);
  assert.equal(await cache.load('asset', async () => 'recovered'), 'recovered');
});

test('closing a project aborts pending decodes and rejects late results after reopening', async () => {
  const cache = new ThumbnailCache<string>();
  let finish: (value: string) => void = () => {};
  let signal: AbortSignal | undefined;
  const old = cache.load('asset', (value) => {
    signal = value;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const rejected = assert.rejects(old, { name: 'AbortError' });
  await Promise.resolve();
  cache.clear();
  assert.equal(signal?.aborted, true);
  const fresh = cache.load('asset', async () => 'new frame');
  finish('stale frame');
  await rejected;
  assert.equal(await fresh, 'new frame');
  assert.equal(cache.get('asset'), 'new frame');
  cache.clear();
  assert.equal(cache.get('asset'), undefined);
});
