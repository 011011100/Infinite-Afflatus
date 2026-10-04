import assert from 'node:assert/strict';
import test from 'node:test';
import { ThumbnailCache } from '../src/renderer/src/features/workspace/thumbnail-cache';
import { ThumbnailScheduler } from '../src/renderer/src/features/workspace/thumbnail-scheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('all keys share at most three active decodes and queued work starts as slots finish', async () => {
  const cache = new ThumbnailCache<number>();
  const tasks = Array.from({ length: 8 }, () => deferred<number>());
  const started: number[] = [];
  let active = 0;
  let maximum = 0;
  const requests = tasks.map((task, index) =>
    cache.load(String(index), () => {
      started.push(index);
      maximum = Math.max(maximum, ++active);
      return task.promise.finally(() => active--);
    }),
  );
  await flush();
  assert.deepEqual(started, [0, 1, 2]);
  assert.deepEqual(cache.stats(), {
    active: 3,
    queued: 5,
    entries: 0,
    bytes: 0,
  });
  for (let index = 0; index < tasks.length; index++) {
    tasks[index]?.resolve(index);
    await flush();
    assert.ok(cache.stats().active <= 3);
  }
  assert.deepEqual(await Promise.all(requests), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(maximum, 3);
  assert.equal(active, 0);
  assert.equal(cache.stats().queued, 0);
});

test('one canceled consumer cannot abort another consumer of the same content', async () => {
  const cache = new ThumbnailCache<object>();
  const task = deferred<object>();
  const first = new AbortController();
  const second = new AbortController();
  let decodes = 0;
  let signal: AbortSignal | undefined;
  const decode = (current: AbortSignal) => {
    signal = current;
    decodes++;
    return task.promise;
  };
  const a = cache.load('shared', decode, { signal: first.signal });
  const b = cache.load('shared', decode, { signal: second.signal });
  const rejected = assert.rejects(a, { name: 'AbortError' });
  await flush();
  first.abort();
  await rejected;
  assert.equal(signal?.aborted, false);
  assert.equal(decodes, 1);
  const frame = {};
  task.resolve(frame);
  assert.equal(await b, frame);
  assert.equal(cache.get('shared'), frame);
  second.abort();
  assert.equal(
    cache.get('shared'),
    frame,
    'Completed consumers do not erase warm frames',
  );
});

test('the last queued consumer leaves without ever creating a decoder', async () => {
  const cache = new ThumbnailCache<number>({ maxActive: 1 });
  const running = deferred<number>();
  const first = cache.load('running', () => running.promise);
  const a = new AbortController();
  const b = new AbortController();
  let skipped = 0;
  const queuedA = cache.load(
    'queued',
    async () => {
      skipped++;
      return 1;
    },
    { signal: a.signal },
  );
  const queuedB = cache.load(
    'queued',
    async () => {
      skipped++;
      return 2;
    },
    { signal: b.signal },
  );
  const rejectedA = assert.rejects(queuedA, { name: 'AbortError' });
  const rejectedB = assert.rejects(queuedB, { name: 'AbortError' });
  await flush();
  a.abort();
  assert.equal(cache.stats().queued, 1);
  b.abort();
  assert.equal(cache.stats().queued, 0);
  await Promise.all([rejectedA, rejectedB]);
  running.resolve(0);
  await first;
  await flush();
  assert.equal(skipped, 0);
  assert.equal(await cache.load('queued', async () => 3), 3);
});

test('last-consumer cancellation rejects immediately but counts a slow decoder until it settles', async () => {
  const cache = new ThumbnailCache<string>({ maxActive: 1 });
  const task = deferred<string>();
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  const old = cache.load(
    'old',
    (value) => {
      signal = value;
      return task.promise;
    },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(old, { name: 'AbortError' });
  await flush();
  controller.abort();
  await rejected;
  assert.equal(signal?.aborted, true);
  let nextStarted = false;
  const next = cache.load('next', async () => {
    nextStarted = true;
    return 'new';
  });
  await flush();
  assert.equal(nextStarted, false);
  assert.equal(cache.stats().active, 1);
  assert.equal(cache.stats().queued, 1);
  task.resolve('late discarded image');
  assert.equal(await next, 'new');
  assert.equal(cache.get('old'), undefined);
});

test('clear rejects active and queued consumers immediately without exceeding the actual decoder limit', async () => {
  const cache = new ThumbnailCache<string>({ maxActive: 1 });
  const task = deferred<string>();
  let queuedStarted = false;
  const active = cache.load('active', () => task.promise);
  const queued = cache.load('queued', async () => {
    queuedStarted = true;
    return 'wrong';
  });
  const rejected = Promise.all([
    assert.rejects(active, { name: 'AbortError' }),
    assert.rejects(queued, { name: 'AbortError' }),
  ]);
  await flush();
  cache.clear();
  await rejected;
  assert.equal(cache.stats().queued, 0);
  let newStarted = false;
  const next = cache.load('active', async () => {
    newStarted = true;
    return 'new session';
  });
  await flush();
  assert.equal(newStarted, false);
  assert.equal(queuedStarted, false);
  task.resolve('old session');
  assert.equal(await next, 'new session');
  assert.equal(cache.get('active'), 'new session');
});

test('a late old settlement cannot remove a new same-key request after clear', async () => {
  const cache = new ThumbnailCache<string>({ maxActive: 2 });
  const oldTask = deferred<string>();
  const newTask = deferred<string>();
  const old = cache.load('same', () => oldTask.promise);
  const rejected = assert.rejects(old, { name: 'AbortError' });
  await flush();
  cache.clear();
  const fresh = cache.load('same', () => newTask.promise);
  await flush();
  oldTask.resolve('stale');
  await rejected;
  await flush();
  const joined = cache.load('same', async () => 'must not decode');
  assert.equal(joined, fresh);
  assert.equal(cache.get('same'), undefined);
  newTask.resolve('fresh');
  assert.equal(await fresh, 'fresh');
  assert.equal(cache.get('same'), 'fresh');
});

test('higher priority and same-key promotion win queued slots without changing the original decoder', async () => {
  const cache = new ThumbnailCache<string>({ maxActive: 1 });
  const blocker = deferred<string>();
  const running = cache.load('running', () => blocker.promise);
  const order: string[] = [];
  const request = (key: string, priority: number) =>
    cache.load(
      key,
      async () => {
        order.push(key);
        return key;
      },
      { priority },
    );
  const a = request('a', 0);
  const b = request('b', 0);
  const visible = request('visible', 1);
  const promoted = cache.load(
    'b',
    async () => {
      throw new Error('Same-key content changed');
    },
    { priority: 2 },
  );
  assert.equal(promoted, b);
  blocker.resolve('running');
  await Promise.all([running, a, b, visible, promoted]);
  assert.deepEqual(order, ['b', 'visible', 'a']);
});

test('priority-only changes keep the active consumer and decoder stable while promoting queued work', async () => {
  const cache = new ThumbnailCache<string>({ maxActive: 1 });
  const blocker = deferred<string>();
  let signal: AbortSignal | undefined;
  let starts = 0;
  const decode = (current: AbortSignal) => {
    signal = current;
    starts++;
    return blocker.promise;
  };
  const running = cache.load('active', decode);
  const order: string[] = [];
  const a = cache.load('a', async () => {
    order.push('a');
    return 'a';
  });
  const b = cache.load('b', async () => {
    order.push('b');
    return 'b';
  });
  await flush();
  cache.promote('active', 2);
  cache.promote('b', 2);
  cache.promote('absent', 3);
  assert.equal(signal?.aborted, false);
  assert.equal(starts, 1);
  assert.equal(cache.load('active', decode), running);
  assert.equal(cache.stats().queued, 2);
  blocker.resolve('same frame');
  assert.equal(await running, 'same frame');
  await Promise.all([a, b]);
  assert.deepEqual(order, ['b', 'a']);
  assert.equal(starts, 1);
});

test('decode rejection, synchronous throw and invalid cost each release their slot and can be retried', async () => {
  const cache = new ThumbnailCache<string>({
    maxActive: 1,
    cost: (value) => {
      if (value === 'cost-error') throw new Error('cost unavailable');
      if (value === 'invalid-cost') return Number.NaN;
      return 1;
    },
  });
  const rejectedDecode = assert.rejects(
    cache.load('decode', () => Promise.reject(new Error('decode failed'))),
    /decode failed/,
  );
  const rejectedSync = assert.rejects(
    cache.load('sync', () => {
      throw new Error('sync failed');
    }),
    /sync failed/,
  );
  const rejectedCost = assert.rejects(
    cache.load('cost', async () => 'cost-error'),
    /cost unavailable/,
  );
  const rejectedInvalid = assert.rejects(
    cache.load('invalid', async () => 'invalid-cost'),
    /pixel cost/,
  );
  const valid = cache.load('valid', async () => 'valid');
  await Promise.all([
    rejectedDecode,
    rejectedSync,
    rejectedCost,
    rejectedInvalid,
  ]);
  assert.equal(await valid, 'valid');
  assert.equal(cache.get('cost'), undefined);
  assert.equal(cache.get('invalid'), undefined);
  assert.equal(await cache.load('cost', async () => 'recovered'), 'recovered');
  await flush();
  assert.equal(cache.stats().active, 0);
  assert.equal(cache.stats().queued, 0);
});

function frame(id: string, width = 2, height = 2) {
  return Object.freeze({
    id,
    image: Object.freeze({ width, height }),
    duration: 10,
  });
}
test('pixel LRU touches synchronous hits and only drops owned references on eviction or clear', async () => {
  const cache = new ThumbnailCache<ReturnType<typeof frame>>({ maxBytes: 32 });
  const a = frame('a');
  const b = frame('b');
  const c = frame('c');
  await cache.load('a', async () => a);
  const retainedByConsumer = await cache.load('b', async () => b);
  assert.equal(cache.stats().bytes, 32);
  assert.equal(cache.get('a'), a);
  await cache.load('c', async () => c);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), a);
  assert.equal(cache.get('c'), c);
  assert.equal(retainedByConsumer, b);
  assert.deepEqual(retainedByConsumer.image, { width: 2, height: 2 });
  cache.clear();
  assert.equal(cache.stats().bytes, 0);
  assert.deepEqual(retainedByConsumer.image, { width: 2, height: 2 });
});

test('oversized frames are delivered without evicting smaller warm frames or exceeding the cache budget', async () => {
  const cache = new ThumbnailCache<ReturnType<typeof frame>>({ maxBytes: 16 });
  const small = frame('small');
  const large = frame('large', 3, 3);
  await cache.load('small', async () => small);
  let decodes = 0;
  const decode = async () => {
    decodes++;
    return large;
  };
  assert.equal(await cache.load('large', decode), large);
  assert.equal(cache.get('large'), undefined);
  assert.equal(cache.get('small'), small);
  assert.equal(cache.stats().bytes, 16);
  await cache.load('large', decode);
  assert.equal(decodes, 2);
  // Accounting only: these are numeric dimensions, not an allocation of a real 64 MiB canvas.
  const defaults = new ThumbnailCache<ReturnType<typeof frame>>();
  await defaults.load('budget', async () => frame('budget', 4096, 4096));
  assert.equal(defaults.stats().bytes, 64 * 1024 * 1024);
  await defaults.load('another', async () => small);
  assert.equal(defaults.get('budget'), undefined);
  assert.equal(defaults.stats().bytes, 16);
});

test('already canceled consumers do not touch a warm entry or start new decodes', async () => {
  const cache = new ThumbnailCache<string>();
  const signal = AbortSignal.abort();
  let started = 0;
  await assert.rejects(
    cache.load(
      'cold',
      async () => {
        started++;
        return 'cold';
      },
      { signal },
    ),
    { name: 'AbortError' },
  );
  await cache.load('warm', async () => 'warm');
  await assert.rejects(
    cache.load('warm', async () => 'wrong', { signal }),
    { name: 'AbortError' },
  );
  assert.equal(started, 0);
  assert.equal(cache.get('warm'), 'warm');
});

test('independent caches can share one decoder limit without sharing keys or retained values', async () => {
  const scheduler = new ThumbnailScheduler(1);
  const frames = new ThumbnailCache<string>({ scheduler });
  const metadata = new ThumbnailCache<number>({ scheduler });
  const task = deferred<string>();
  const first = frames.load('same', () => task.promise);
  let started = false;
  const second = metadata.load('same', async () => {
    started = true;
    return 24;
  });
  await flush();
  assert.equal(started, false);
  assert.equal(scheduler.stats().active, 1);
  task.resolve('pixels');
  assert.equal(await first, 'pixels');
  assert.equal(await second, 24);
  assert.equal(frames.get('same'), 'pixels');
  assert.equal(metadata.get('same'), 24);
});

test('clearing one cache preserves consumers queued by another cache on the shared scheduler', async () => {
  const scheduler = new ThumbnailScheduler(1);
  const frames = new ThumbnailCache<string>({ scheduler });
  const metadata = new ThumbnailCache<number>({ scheduler });
  const task = deferred<string>();
  const pixels = frames.load('same', () => task.promise);
  const rejected = assert.rejects(pixels, { name: 'AbortError' });
  let metadataSignal: AbortSignal | undefined;
  const duration = metadata.load('same', async (signal) => {
    metadataSignal = signal;
    return 12;
  });
  await flush();
  frames.clear();
  await rejected;
  assert.deepEqual(scheduler.stats(), { active: 1, queued: 1 });
  task.resolve('discarded pixels');
  assert.equal(await duration, 12);
  assert.equal(metadataSignal?.aborted, false);
  assert.equal(metadata.get('same'), 12);
  assert.equal(frames.get('same'), undefined);
});
