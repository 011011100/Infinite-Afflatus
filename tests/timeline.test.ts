import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTimeline,
  formatTime,
  locateTime,
  totalDuration,
} from '../src/renderer/src/features/workspace/editor/timeline';
import { changeTrim, clipRange } from '../src/shared/canvas/trim';
import type { Asset } from '../src/shared/models';

const assets = ['a', 'b', 'c'].map((id) => ({ id, name: id }) as Asset);

test('unified time maps trimmed offsets to source time, including exact joins and final end', () => {
  const clips = buildTimeline(
    assets,
    new Map([
      ['a', 4],
      ['b', 4],
      ['c', 5],
    ]),
    { a: { start: 1, end: 3 }, b: { start: 0.5, end: 2.5 } },
  );
  assert.equal(totalDuration(clips), 9);
  assert.deepEqual(
    clips.map((clip) => clip.offset),
    [0, 2, 4],
  );
  assert.deepEqual(locateTime(clips, -1), { index: 0, sourceTime: 1 });
  assert.deepEqual(locateTime(clips, 2), { index: 1, sourceTime: 0.5 });
  assert.deepEqual(locateTime(clips, 3), { index: 1, sourceTime: 1.5 });
  assert.deepEqual(locateTime(clips, 99), { index: 2, sourceTime: 5 });
});

test('trim handles cannot cross or exceed source; trimmed content can be restored', () => {
  assert.deepEqual(changeTrim({ start: 1, end: 3 }, 'start', 9, 4), {
    start: 2.9,
    end: 3,
  });
  assert.deepEqual(changeTrim({ start: 1, end: 3 }, 'end', -1, 4), {
    start: 1,
    end: 1.1,
  });
  assert.deepEqual(changeTrim({ start: 1, end: 3 }, 'start', -1, 4), {
    start: 0,
    end: 3,
  });
  assert.deepEqual(changeTrim({ start: 1, end: 3 }, 'end', 9, 4), {
    start: 1,
    end: 4,
  });
  assert.deepEqual(clipRange(0.05), { start: 0, end: 0.05 });
  assert.deepEqual(clipRange(4, { start: 9, end: 10 }), { start: 3.9, end: 4 });
  assert.equal(formatTime(59.98), '01:00.0');
});
