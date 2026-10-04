import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detachMaterial,
  groupMaterials,
  materialSelection,
} from '../src/shared/generation/material-groups';
import {
  emptyWorkspace,
  MATERIAL_HEIGHT,
  MATERIAL_WIDTH,
  newShot,
  validateWorkspace,
} from '../src/shared/generation/workspace';
import type { GenerationGroup } from '../src/shared/generation/workspace-types';

function videoGroup(group: GenerationGroup | undefined) {
  assert.ok(group && group.kind !== 'image');
  return group;
}

function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}

function sample(count = 5) {
  const shot = newShot('shot', '镜头', { x: 0, y: 0 });
  shot.nodes = Array.from({ length: count }, (_, i) => ({
    id: `material-${i}`,
    type: 'text',
    text: `镜头文本 ${i}`,
    position: { x: 80 + i * 300, y: 100 },
  }));
  return shot;
}

test('group plus material includes all members once and retains existing parameters', () => {
  const original = groupMaterials(
    sample(),
    ['material-0', 'material-1'],
    'first',
  );
  videoGroup(original.groups[0]).parameters.duration = 12;
  const ids = ['first', 'material-0', 'material-2', 'first'];
  assert.equal(materialSelection(original, ids).materials.length, 3);
  const merged = groupMaterials(original, ids, 'merged');
  assert.equal(merged.groups.length, 1);
  assert.equal(videoGroup(merged.groups[0]).parameters.duration, 12);
  assert.deepEqual(
    merged.nodes.filter((n) => n.groupId === 'merged').map((n) => n.id),
    ['material-0', 'material-1', 'material-2'],
  );
  assert.deepEqual(merged.nodes.slice(3), original.nodes.slice(3));
  assert.deepEqual(
    merged.nodes.map((n) => n.type === 'text' && n.text),
    original.nodes.map((n) => n.type === 'text' && n.text),
  );
  assert.equal(original.nodes[2]?.groupId, undefined);
  validateWorkspace({ ...emptyWorkspace(), shots: [merged] });
});

test('two moved groups flatten into one, prefer active settings, and leave other groups untouched', () => {
  let original = groupMaterials(
    sample(),
    ['material-0', 'material-1'],
    'first',
  );
  original = groupMaterials(original, ['material-2', 'material-3'], 'second');
  original = groupMaterials(original, ['material-4'], 'other');
  const first = videoGroup(original.groups[0]);
  const second = videoGroup(original.groups[1]);
  first.position = { x: -500, y: 400 };
  second.position = { x: 200, y: 600 };
  first.parameters.duration = 6;
  second.parameters.duration = 13;
  const merged = groupMaterials(
    original,
    ['second', 'first', 'material-2'],
    'merged',
    'second',
  );
  const result = videoGroup(merged.groups.find((g) => g.id === 'merged'));
  assert.equal(result.parameters.duration, 13);
  assert.deepEqual(result.position, first.position);
  assert.deepEqual(
    merged.groups.find((g) => g.id === 'other'),
    original.groups[2],
  );
  assert.deepEqual(merged.nodes[4], original.nodes[4]);
  assert.equal(merged.nodes.filter((n) => n.groupId === 'merged').length, 4);
  assert.equal(merged.groups.length, 2);
  const fallback = groupMaterials(original, ['second', 'first'], 'fallback');
  assert.equal(
    videoGroup(fallback.groups.find((g) => g.id === 'fallback')).parameters
      .duration,
    6,
  );
  result.parameters.duration = 9;
  assert.equal(second.parameters.duration, 13);
  validateWorkspace({ ...emptyWorkspace(), shots: [merged] });
});

test('moving only a selected member into another group preserves its unselected siblings', () => {
  const original = groupMaterials(
    sample(),
    ['material-0', 'material-1'],
    'first',
  );
  const merged = groupMaterials(
    original,
    ['material-1', 'material-2'],
    'merged',
  );
  assert.deepEqual(merged.nodes[0], original.nodes[0]);
  assert.deepEqual(merged.groups[0], original.groups[0]);
  assert.equal(merged.nodes[1]?.groupId, 'merged');
  assert.equal(merged.nodes[2]?.groupId, 'merged');
  validateWorkspace({ ...emptyWorkspace(), shots: [merged] });
});

test('selection limits use expanded material count and reject over-capacity merges without changing data', () => {
  const original = groupMaterials(
    sample(33),
    Array.from({ length: 32 }, (_, i) => `material-${i}`),
    'full',
  );
  const before = structuredClone(original);
  const selection = materialSelection(original, [
    'full',
    'material-0',
    'material-32',
  ]);
  assert.equal(selection.materials.length, 33);
  assert.equal(selection.canGroup, false);
  assert.throws(
    () => groupMaterials(original, ['full', 'material-32'], 'merged'),
    /1–32/,
  );
  assert.deepEqual(original, before);
  assert.equal(
    materialSelection(original, ['full', 'material-0']).canGroup,
    false,
  );
  assert.equal(groupMaterials(original, ['full'], 'unchanged'), original);
});

test('detaching a middle material preserves siblings, original group settings, and finds space outside groups', () => {
  const original = groupMaterials(
    sample(),
    ['material-0', 'material-1', 'material-2'],
    'group',
  );
  required(original.groups[0]).position = { x: 100, y: 200 };
  videoGroup(original.groups[0]).parameters.duration = 11;
  const split = detachMaterial(original, 'material-1');
  assert.deepEqual(split.groups, original.groups);
  assert.deepEqual(
    split.nodes.filter((n) => n.id !== 'material-1'),
    original.nodes.filter((n) => n.id !== 'material-1'),
  );
  const card = required(split.nodes[1]);
  assert.equal(card.groupId, undefined);
  assert.equal(card.type === 'text' && card.text, '镜头文本 1');
  for (const group of split.groups) {
    assert.ok(
      card.position.x + MATERIAL_WIDTH <= group.position.x ||
        card.position.x >= group.position.x + group.width ||
        card.position.y + MATERIAL_HEIGHT <= group.position.y ||
        card.position.y >= group.position.y + group.height,
    );
  }
  assert.equal(original.nodes[1]?.groupId, 'group');
  validateWorkspace({ ...emptyWorkspace(), shots: [split] });
});

test('detaching the last member removes only the empty frame and keeps absolute position and asset identity', () => {
  let original = sample();
  original.nodes[0] = {
    id: 'material-0',
    type: 'asset',
    assetId: 'asset',
    position: { x: 80, y: 100 },
  };
  original = groupMaterials(original, ['material-0'], 'group');
  required(original.groups[0]).position = { x: 500, y: 600 };
  const split = detachMaterial(original, 'material-0');
  assert.equal(split.groups.length, 0);
  assert.deepEqual(split.nodes[0], {
    id: 'material-0',
    type: 'asset',
    assetId: 'asset',
    position: { x: 520, y: 652 },
  });
  assert.deepEqual(split.nodes.slice(1), original.nodes.slice(1));
  assert.equal(detachMaterial(split, 'material-0'), split);
  assert.equal(detachMaterial(split, 'unknown'), split);
});

test('repeated detach and rejoin keeps each material exactly once', () => {
  let shot = groupMaterials(
    sample(3),
    ['material-0', 'material-1', 'material-2'],
    'group',
  );
  for (let i = 0; i < 6; i++) {
    const group = required(shot.groups[0]);
    shot = detachMaterial(shot, 'material-1');
    shot = groupMaterials(shot, [group.id, 'material-1'], `group-${i}`);
    validateWorkspace({ ...emptyWorkspace(), shots: [shot] });
    assert.equal(shot.groups.length, 1);
    assert.equal(shot.nodes.length, 3);
    assert.equal(new Set(shot.nodes.map((n) => n.id)).size, 3);
    assert.ok(shot.nodes.every((n) => n.groupId === `group-${i}`));
  }
});
