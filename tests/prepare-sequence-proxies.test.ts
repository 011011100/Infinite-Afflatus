import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { prepareSequenceProxies } from '../src/renderer/src/features/workspace/playback/prepare-sequence-proxies';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('proxy preparation retains an editor lease before any prepare and releases a late lease on close', async () => {
  const acquire = deferred<string>();
  const prepared: string[] = [];
  const released: string[] = [];
  const dispose = prepareSequenceProxies(
    {
      acquireProxyUsage: () => acquire.promise,
      releaseProxyUsage: async (token) => {
        released.push(token);
      },
      prepareProxy: async (_project, asset) => {
        prepared.push(asset);
        return { ready: true };
      },
    },
    'project',
    ['asset'],
    () => assert.fail('Closed editor received a proxy'),
    () => assert.fail('Closed editor received a status'),
  );
  assert.deepEqual(prepared, []);
  dispose();
  acquire.resolve('late');
  await setImmediate();
  assert.deepEqual(prepared, []);
  assert.deepEqual(released, ['late']);
  dispose();
  assert.deepEqual(released, ['late']);
});

test('proxy preparation keeps paused editor protected until disposal, suppressing late results', async () => {
  const pending = deferred<{ ready: boolean }>();
  const released: string[] = [];
  const ready: string[] = [];
  const finished: boolean[] = [];
  const dispose = prepareSequenceProxies(
    {
      acquireProxyUsage: async () => 'editor',
      releaseProxyUsage: async (token) => {
        released.push(token);
      },
      prepareProxy: async (_project, asset) =>
        asset === 'first' ? { ready: true } : pending.promise,
    },
    'project',
    ['first', 'second'],
    (_index, url) => ready.push(url),
    (value) => finished.push(value),
  );
  await setImmediate();
  assert.deepEqual(ready, ['afflatus-media://proxy/project/first']);
  assert.deepEqual(released, []);
  dispose();
  pending.resolve({ ready: true });
  await setImmediate();
  assert.deepEqual(released, ['editor']);
  assert.deepEqual(ready, ['afflatus-media://proxy/project/first']);
  assert.deepEqual(finished, []);
});

test('failed proxy preparation preserves fallback and releases protection exactly once', async () => {
  const released: string[] = [];
  const finished: boolean[] = [];
  const dispose = prepareSequenceProxies(
    {
      acquireProxyUsage: async () => 'editor',
      releaseProxyUsage: async (token) => {
        released.push(token);
      },
      prepareProxy: async () => {
        throw new Error('FFmpeg unavailable');
      },
    },
    'project',
    ['asset'],
    () => assert.fail('Failed proxy used'),
    (value) => finished.push(value),
  );
  await setImmediate();
  assert.deepEqual(finished, [false]);
  assert.deepEqual(released, []);
  dispose();
  dispose();
  assert.deepEqual(released, ['editor']);
});

test('failed protection never prepares an unprotected proxy', async () => {
  const finished: boolean[] = [];
  prepareSequenceProxies(
    {
      acquireProxyUsage: async () => {
        throw new Error('Migration');
      },
      releaseProxyUsage: async () => assert.fail('No lease to release'),
      prepareProxy: async () => {
        assert.fail('Prepared without protection');
      },
    },
    'project',
    ['asset'],
    () => assert.fail('No proxy'),
    (value) => finished.push(value),
  );
  await setImmediate();
  assert.deepEqual(finished, [false]);
});
