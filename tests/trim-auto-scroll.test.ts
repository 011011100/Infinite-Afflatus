import assert from 'node:assert/strict';
import test from 'node:test';
import {
  edgeScrollSpeed,
  trimFollowDelta,
  trimScrollDelta,
} from '../src/renderer/src/features/workspace/editor/trim-auto-scroll';
import {
  advanceTrimDrag,
  type TrimDrag,
} from '../src/renderer/src/features/workspace/editor/trim-drag';

test('fast trim movements are revealed immediately on either side without a speed cap', () => {
  for (const [left, right] of [
    [16, 984],
    [416, 984],
    [16, 304],
  ] as const) {
    assert.equal(trimFollowDelta((left + right) / 2, left, right), 0);
    for (const overflow of [1, 30, 300, 2000]) {
      for (const edgeX of [left - overflow, right + overflow]) {
        const pan = trimFollowDelta(edgeX, left, right);
        assert.equal(Math.abs(pan), overflow);
        assert.ok(edgeX - pan >= left && edgeX - pan <= right);
      }
    }
  }
});

test('both edge zones accelerate symmetrically and stop in the interior', () => {
  assert.equal(edgeScrollSpeed(500, 20, 980), 0);
  assert.equal(edgeScrollSpeed(76, 20, 980), 0);
  for (const distance of [0, 10, 30, 55]) {
    const left = edgeScrollSpeed(20 + distance, 20, 980);
    assert.equal(left, -edgeScrollSpeed(980 - distance, 20, 980));
    assert.ok(left < 0);
  }
  assert.ok(
    Math.abs(edgeScrollSpeed(25, 20, 980)) >
      Math.abs(edgeScrollSpeed(60, 20, 980)),
  );
  assert.equal(edgeScrollSpeed(-100, 20, 980), -600);
  assert.equal(edgeScrollSpeed(2000, 20, 980), 600);
});

test('auto-scroll stops at source and minimum duration limits in all four directions', () => {
  const range = { start: 10, end: 20 };
  const drag = (time: number): TrimDrag => ({ time, boundary: 0, pull: 0 });
  assert.equal(trimScrollDelta(drag(1), -500, 100, range, 'start', 30), -100);
  assert.equal(trimScrollDelta(drag(0), -500, 100, range, 'start', 30), 0);
  assert.equal(trimScrollDelta(drag(30), 500, 100, range, 'end', 30), 0);
  assert.equal(trimScrollDelta(drag(29), 500, 100, range, 'end', 30), 100);
  assert.equal(trimScrollDelta(drag(19.9), 500, 100, range, 'start', 30), 0);
  assert.equal(trimScrollDelta(drag(10.1), -500, 100, range, 'end', 30), 0);
});

test('stationary pointer continuously extends both handles with frame-rate independent scrolling', () => {
  for (const edge of ['start', 'end'] as const) {
    for (const fps of [60, 120]) {
      const range = { start: 10, end: 20 };
      let drag: TrimDrag = { time: range[edge], boundary: 0, pull: 0 };
      for (let frame = 0; frame < fps; frame++) {
        const delta = trimScrollDelta(
          drag,
          ((edge === 'start' ? -1 : 1) * 600) / fps,
          100,
          range,
          edge,
          40,
        );
        drag = advanceTrimDrag(drag, delta, 100, range, edge, 40);
      }
      assert.ok(Math.abs(drag.time - (edge === 'start' ? 4 : 26)) < 0.00001);
    }
  }
});
