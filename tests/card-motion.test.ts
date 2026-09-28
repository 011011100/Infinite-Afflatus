import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bridgePath,
  motionPieces,
  regrouping,
  type Surface,
  surfacePath,
} from '../src/renderer/src/features/workspace/motion/geometry';
import type { CanvasCard } from '../src/shared/canvas/model';
import {
  joinCards,
  reversePatch,
  splitSelectedAsset,
} from '../src/shared/canvas/operations';

const card = (id: string, assetIds: string[], x = 0): CanvasCard => ({
  id,
  assetIds,
  position: { x, y: 0 },
});

test('motion follows every contiguous part of a middle split and its undo without bridging unrelated cards', () => {
  const source = card('source', ['1', '2', '3', '4', '5']);
  let id = 0;
  const split = splitSelectedAsset(source, '3', () => `split-${++id}`);
  assert.equal(regrouping(split), true);
  assert.deepEqual(
    motionPieces(split).map((part) => part.assetIds),
    [['1', '2'], ['3'], ['4', '5']],
  );
  assert.deepEqual(
    motionPieces(reversePatch(split)).map((part) => part.assetIds),
    [['1', '2'], ['3'], ['4', '5']],
  );
  const merged = joinCards(
    card('moving', ['a', 'b']),
    card('target', ['c']),
    'left',
  );
  assert.deepEqual(
    motionPieces(merged).map((part) => part.assetIds),
    [['a', 'b'], ['c']],
  );
  assert.equal(
    regrouping({
      before: [source],
      after: [{ ...source, position: { x: 100, y: 40 } }],
    }),
    false,
  );
});

test('liquid neck only connects close, aligned surfaces and pinches off at its reach', () => {
  const left: Surface = {
    x: 0,
    y: 0,
    width: 216,
    height: 202,
    left: 8,
    right: 8,
  };
  for (const gap of [0, 8, 24, 38]) {
    const right = { ...left, x: 216 + gap };
    const path = bridgePath(left, right);
    assert.ok(path.startsWith('M'));
    assert.ok(!/NaN|Infinity/.test(path));
    assert.equal(bridgePath(right, left), path);
  }
  assert.equal(bridgePath(left, { ...left, x: 272 }), '');
  assert.equal(bridgePath(left, { ...left, x: 264 }), '');
  assert.equal(bridgePath(left, { ...left, x: 220, y: 100 }), '');
  assert.equal(bridgePath(left, { ...left, x: 100 }), '');
  assert.ok(!/NaN|Infinity/.test(surfacePath({ ...left, width: 0.01 })));
});
