import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendGroupText,
  editMaterialText,
  reorderGroupMembers,
} from '../src/shared/generation/group-editing';
import {
  detachMaterial,
  groupMaterials,
} from '../src/shared/generation/material-groups';
import {
  emptyWorkspace,
  newShot,
  validateWorkspace,
} from '../src/shared/generation/workspace';
import { BlockDrag } from '../src/shared/interaction/block-drag';

function sample() {
  const shot = newShot('shot', '镜头', { x: 0, y: 0 });
  shot.nodes = [
    { id: 'first', type: 'text', text: '开场', position: { x: 0, y: 0 } },
    {
      id: 'image',
      type: 'asset',
      assetId: 'image-source',
      position: { x: 300, y: 0 },
    },
    { id: 'second', type: 'text', text: '动作', position: { x: 600, y: 0 } },
    { id: 'other', type: 'text', text: '组外', position: { x: 1000, y: 0 } },
  ];
  return groupMaterials(shot, ['first', 'image', 'second'], 'group');
}

test('text reordering preserves independent content, media slots, parameters, and canvas positions', () => {
  const shot = sample();
  const result = reorderGroupMembers(shot, 'group', ['second', 'first']);
  assert.deepEqual(
    result.nodes.map((n) => n.id),
    ['second', 'image', 'first', 'other'],
  );
  assert.deepEqual(
    result.nodes.map((n) => n.position),
    shot.nodes.map((n) => n.position),
  );
  assert.equal(
    result.nodes[0]?.type === 'text' && result.nodes[0].text,
    '动作',
  );
  assert.deepEqual(result.groups, shot.groups);
  assert.deepEqual(
    shot.nodes.map((n) => n.id),
    ['first', 'image', 'second', 'other'],
  );
  assert.throws(
    () => reorderGroupMembers(shot, 'group', ['second', 'other']),
    /无效/,
  );
  assert.throws(
    () => reorderGroupMembers(shot, 'group', ['first', 'first']),
    /无效/,
  );
  validateWorkspace({ ...emptyWorkspace(), shots: [result] });
});

test('default text insertion is idempotent and grows the group without replacing selected material', () => {
  const shot = sample();
  const added = appendGroupText(shot, 'group', 'empty');
  assert.equal(added.nodes.filter((n) => n.id === 'empty').length, 1);
  assert.equal(appendGroupText(added, 'group', 'empty'), added);
  assert.ok((added.groups[0]?.height ?? 0) > (shot.groups[0]?.height ?? 0));
  assert.deepEqual(added.nodes.slice(0, 4), shot.nodes);
  assert.equal(appendGroupText(shot, 'missing', 'empty'), shot);
  validateWorkspace({ ...emptyWorkspace(), shots: [added] });
});

test('text file edits retain the reference and follow the block when detached at a drop point', () => {
  const shot = sample();
  const edited = editMaterialText(shot, 'image', '项目内的修改内容');
  const detached = detachMaterial(edited, 'image', { x: 1600, y: 800 });
  const node = detached.nodes.find((n) => n.id === 'image');
  assert.ok(node?.type === 'asset');
  assert.equal(node.assetId, 'image-source');
  assert.equal(node.textOverride, '项目内的修改内容');
  assert.equal(node.groupId, undefined);
  assert.deepEqual(node.position, { x: 1470, y: 678 });
  assert.equal(
    shot.nodes[1]?.type === 'asset' && shot.nodes[1].textOverride,
    undefined,
  );
  validateWorkspace({ ...emptyWorkspace(), shots: [detached] });
  assert.throws(
    () =>
      validateWorkspace({
        ...emptyWorkspace(),
        shots: [editMaterialText(shot, 'image', 'a'.repeat(10001))],
      }),
    /10000/,
  );
});

test('new text fills a vacant member slot and refuses to exceed group capacity', () => {
  const shot = sample();
  const detached = detachMaterial(shot, 'first');
  const added = appendGroupText(detached, 'group', 'replacement');
  assert.deepEqual(
    added.nodes.find((node) => node.id === 'replacement')?.position,
    shot.nodes[0]?.position,
  );
  let full = shot;
  for (let i = 3; i < 32; i++)
    full = appendGroupText(full, 'group', `text-${i}`);
  assert.equal(
    full.nodes.filter((node) => node.groupId === 'group').length,
    32,
  );
  assert.equal(appendGroupText(full, 'group', 'overflow'), full);
  validateWorkspace({ ...emptyWorkspace(), shots: [full] });
});

test('a picked-up block commits only after movement and release; early motion stays a normal gesture', () => {
  const drag = new BlockDrag();
  drag.start(1, 100, 100, 0);
  assert.equal(drag.lift(699), false);
  assert.equal(drag.lift(700), true);
  assert.equal(drag.release(1, 100, 100), false);
  drag.start(1, 100, 100, 0);
  assert.equal(drag.move(1, 100, 110), false);
  assert.equal(drag.lift(800), false);
  drag.start(1, 100, 100, 0);
  assert.equal(drag.lift(710), true);
  assert.equal(drag.move(1, 100, 200), true);
  assert.equal(drag.release(1, 100, 200), true);
  assert.equal(drag.release(1, 100, 200), false);
});

test('cancellation and foreign pointers cannot commit a text block move', () => {
  const drag = new BlockDrag();
  drag.start(1, 100, 100, 0);
  drag.lift(750);
  assert.equal(drag.release(2, 100, 200), false);
  assert.equal(drag.active, true);
  drag.cancel();
  assert.equal(drag.release(1, 100, 200), false);
});
