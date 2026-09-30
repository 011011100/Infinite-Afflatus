import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advanceTrimDrag,
  type TrimDrag,
  trimBoundaryPressure,
} from '../src/renderer/src/features/workspace/editor/trim-drag';
import { changeTrim } from '../src/shared/canvas/trim';

const range = { start: 0, end: 4 };
const initial = (time: number): TrimDrag => ({ time, boundary: 0, pull: 0 });

test('both source limits resist outward input while keeping the source range exact', () => {
  for (const edge of ['start', 'end'] as const) {
    const direction = edge === 'start' ? -1 : 1;
    const contact = advanceTrimDrag(
      initial(edge === 'start' ? 1 : 3),
      direction * 100,
      100,
      range,
      edge,
      4,
    );
    const pull = advanceTrimDrag(contact, direction * 60, 100, range, edge, 4);
    assert.equal(contact.time, range[edge]);
    assert.equal(contact.boundary, direction);
    assert.equal(pull.time, range[edge]);
    assert.ok(
      Math.abs(trimBoundaryPressure(pull)) >
        Math.abs(trimBoundaryPressure(contact)),
    );
    assert.deepEqual(changeTrim(range, edge, pull.time, 4), range);
    assert.equal(advanceTrimDrag(pull, 0, 100, range, edge, 4), pull);
  }
});

test('reverse input immediately trims after a large overshoot on either side', () => {
  for (const edge of ['start', 'end'] as const) {
    const direction = edge === 'start' ? -1 : 1;
    const pull = advanceTrimDrag(
      initial(range[edge]),
      direction * 1000,
      100,
      range,
      edge,
      4,
    );
    const reversed = advanceTrimDrag(pull, -direction * 1, 100, range, edge, 4);
    assert.equal(reversed.time, range[edge] - direction * 0.01);
    assert.equal(reversed.boundary, 0);
    assert.equal(trimBoundaryPressure(reversed), 0);
  }
});

test('minimum duration resists crossing and can immediately expand again', () => {
  for (const edge of ['start', 'end'] as const) {
    const direction = edge === 'start' ? 1 : -1;
    const pull = advanceTrimDrag(
      initial(range[edge]),
      direction * 500,
      100,
      range,
      edge,
      4,
    );
    const cropped = changeTrim(range, edge, pull.time, 4);
    assert.ok(Math.abs(cropped.end - cropped.start - 0.1) < 1e-10);
    assert.equal(pull.boundary, direction);
    const reversed = advanceTrimDrag(
      pull,
      -direction * 10,
      100,
      range,
      edge,
      4,
    );
    assert.ok(Math.abs(reversed.time - (pull.time - direction * 0.1)) < 1e-10);
    assert.equal(reversed.boundary, 0);
  }
});

test('sub-millisecond moves accumulate at high zoom without rounding drift', () => {
  let state = initial(0);
  for (let i = 0; i < 100; i++) {
    state = advanceTrimDrag(state, 0.1, 600, range, 'start', 4);
  }
  assert.equal(changeTrim(range, 'start', state.time, 4).start, 0.017);
});

test('resistance grows with diminishing increments and remains bounded', () => {
  const pressure = (pull: number) =>
    trimBoundaryPressure({ time: 0, boundary: -1, pull });
  assert.ok(
    Math.abs(pressure(30) - pressure(0)) >
      Math.abs(pressure(60) - pressure(30)),
  );
  assert.equal(pressure(100000), -1);
});

test('a source shorter than the minimum stays intact and signals either constraint', () => {
  const short = { start: 0, end: 0.05 };
  for (const edge of ['start', 'end'] as const) {
    let state = initial(short[edge]);
    for (const delta of [-100, 100]) {
      state = advanceTrimDrag(state, delta, 100, short, edge, 0.05);
      assert.deepEqual(changeTrim(short, edge, state.time, 0.05), short);
      assert.equal(state.boundary, Math.sign(delta));
    }
  }
});
