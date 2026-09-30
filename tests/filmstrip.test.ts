import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FilmstripCache,
  type FilmstripRequest,
} from '../src/renderer/src/features/workspace/editor/filmstrip-cache';
import { filmstripTiles } from '../src/renderer/src/features/workspace/editor/filmstrip-layout';

const request = (time: number): FilmstripRequest => ({
  key: `video@${time}`,
  source: 'video',
  time,
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('filmstrip samples different source times, keeps source anchors after head trims', () => {
  const full = filmstripTiles(0, 20, 100, 0, 900, 9 / 16);
  assert.ok(full.tiles.length > 5);
  assert.ok(
    new Set(full.tiles.map((tile) => tile.time)).size === full.tiles.length,
  );
  const trimmed = filmstripTiles(1.25, 20, 100, 0, 900, 9 / 16);
  for (const tile of trimmed.tiles) {
    const original = full.tiles.find((value) => value.time === tile.time);
    if (original) assert.equal(tile.left + 125, original.left);
  }
  assert.ok(trimmed.tiles[0] && trimmed.tiles[0].left <= 0);
});

test('long videos only request visible frames and small overscan, including at high zoom', () => {
  for (const scale of [8, 100, 600]) {
    const strip = filmstripTiles(20, 36000, scale, 4000, 1280, 16 / 9);
    assert.ok(strip.tiles.length < 32);
    assert.ok(strip.width < 2000);
    assert.ok(strip.tiles.every((tile) => tile.time >= 20));
  }
  assert.equal(filmstripTiles(0, 10, 100, 5000, 1000, 1).tiles.length, 0);
  assert.equal(filmstripTiles(0, 10, 100, -5000, 1000, 1).tiles.length, 0);
});

test('scrolling cancels obsolete decoding and keeps decoding serial; stale frames never enter cache', async () => {
  const jobs: {
    signal: AbortSignal;
    done: (value: string) => void;
    time: number;
  }[] = [];
  const cache = new FilmstripCache<string>(
    (req, signal) =>
      new Promise((done) => jobs.push({ signal, done, time: req.time })),
  );
  const owner = {};
  cache.request(owner, [request(0), request(1)]);
  cache.request(owner, [request(0), request(2)]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.signal.aborted, false);
  cache.request(owner, [request(10)]);
  assert.equal(jobs[0]?.signal.aborted, true);
  assert.equal(jobs.length, 1);
  jobs[0]?.done('stale');
  await flush();
  assert.equal(jobs[1]?.time, 10);
  assert.equal(cache.get('video@0'), undefined);
  jobs[1]?.done('current');
  await flush();
  assert.equal(cache.get('video@10'), 'current');
  cache.clear();
});

test('cached frames survive ordinary viewport changes; finite budget cannot cycle forever', async () => {
  let decodes = 0;
  const cache = new FilmstripCache<number>(async (req) => {
    decodes++;
    return req.time;
  }, 3);
  const owner = {};
  cache.request(owner, [0, 1, 2].map(request));
  await flush();
  cache.request(owner, [1, 2].map(request));
  await flush();
  assert.equal(decodes, 3);
  cache.request(owner, [2, 3, 4, 5, 6].map(request));
  await flush();
  assert.equal(decodes, 5);
  assert.equal(cache.get('video@0'), undefined);
  assert.equal(cache.get('video@2'), 2);
  cache.clear();
});

test('closing aborts work and a later request can resume after strict-mode cleanup', async () => {
  let signal: AbortSignal | undefined;
  const cache = new FilmstripCache<number>(async (req, current) => {
    signal = current;
    await flush();
    return req.time;
  });
  const owner = {};
  cache.request(owner, [request(1)]);
  cache.clear();
  assert.equal(signal?.aborted, true);
  cache.request(owner, [request(2)]);
  await flush();
  await flush();
  assert.equal(cache.get('video@1'), undefined);
  assert.equal(cache.get('video@2'), 2);
  cache.release(owner);
  cache.clear();
});
