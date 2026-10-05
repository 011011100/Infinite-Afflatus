import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyGenerationDraft } from '../src/shared/generation/draft';
import { moveMaterials } from '../src/shared/generation/move-materials';
import { ShotHistory } from '../src/shared/generation/shot-history';
import {
  newShot,
  type ShotWorkspace,
} from '../src/shared/generation/workspace';

function fixture(): ShotWorkspace {
  return {
    ...newShot('shot', '键盘移动', { x: 50, y: 70 }),
    nodes: [
      { id: 'free', type: 'text', text: '原文', position: { x: -10, y: 40 } },
      {
        id: 'child',
        type: 'text',
        text: '组内',
        groupId: 'group',
        position: { x: 30, y: 60 },
        width: 200,
        height: 180,
      },
      {
        id: 'other',
        type: 'asset',
        assetId: 'image',
        groupId: 'group',
        position: { x: 250, y: 60 },
      },
    ],
    groups: [
      {
        id: 'group',
        position: { x: 500, y: 100 },
        width: 600,
        height: 400,
        parameters: emptyGenerationDraft().parameters,
      },
    ],
    labels: [
      {
        id: 'label',
        name: '可移',
        color: '#2563eb',
        pinned: false,
        position: { x: 0, y: 0 },
      },
      {
        id: 'fixed',
        name: '固定',
        color: '#2563eb',
        pinned: true,
        position: { x: 50, y: 80 },
      },
    ],
  };
}

test('mixed keyboard selection moves a group once and preserves relative members, parameters and fixed labels', () => {
  const before = fixture();
  const original = structuredClone(before);
  const after = moveMaterials(
    before,
    ['free', 'group', 'child', 'label', 'fixed', 'missing'],
    { x: 20, y: -5 },
  );
  assert.deepEqual(after.nodes[0]?.position, { x: 10, y: 35 });
  assert.equal(after.nodes[1], before.nodes[1]);
  assert.equal(after.nodes[2], before.nodes[2]);
  assert.deepEqual(after.groups[0]?.position, { x: 520, y: 95 });
  assert.equal(after.groups[0]?.parameters, before.groups[0]?.parameters);
  assert.deepEqual(after.labels?.[0]?.position, { x: 20, y: -5 });
  assert.equal(after.labels?.[1], before.labels?.[1]);
  assert.equal(after.position, before.position);
  assert.equal(after.viewport, before.viewport);
  assert.deepEqual(before, original);
});

test('a member stays inside its parent using its own size without changing group membership or layout', () => {
  const before = fixture();
  const low = moveMaterials(before, ['child'], { x: -100, y: -100 });
  assert.deepEqual(low.nodes[1]?.position, { x: 0, y: 0 });
  const high = moveMaterials(low, ['child'], { x: 1000, y: 1000 });
  assert.deepEqual(high.nodes[1]?.position, { x: 400, y: 220 });
  assert.equal(high.nodes[1]?.groupId, 'group');
  assert.equal(high.groups[0], before.groups[0]);
  assert.equal(high.nodes[2], before.nodes[2]);
  assert.equal(moveMaterials(high, ['child'], { x: 20, y: 20 }), high);
  assert.equal(
    moveMaterials(before, ['fixed', 'missing'], { x: 5, y: 0 }),
    before,
  );
});

test('each committed keyboard step is independently undoable and redoable through the existing shot history', () => {
  const before = fixture();
  const history = new ShotHistory();
  const first = moveMaterials(before, ['free'], { x: 5, y: 0 });
  history.record(before, first);
  const second = moveMaterials(first, ['free'], { x: 20, y: 0 });
  history.record(first, second);
  const undone = history.undo(second);
  assert.deepEqual(undone, first);
  assert.deepEqual(history.undo(undone), before);
  assert.deepEqual(history.redo(before), first);
});

test('coordinate limits cannot turn a keyboard step into an unsavable document', () => {
  const before = fixture();
  const node = before.nodes[0];
  assert.ok(node);
  node.position = { x: 1e8 - 0.5, y: -1e8 + 0.5 };
  assert.equal(moveMaterials(before, [node.id], { x: 5, y: -5 }), before);
});
