import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canJoinMaterials,
  joinMaterials,
  materialHoverGroup,
} from '../src/shared/generation/join-materials';
import { materialSize } from '../src/shared/generation/node-geometry';
import {
  emptyWorkspace,
  groupMaterials,
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

function sample() {
  const shot = newShot('shot', '镜头', { x: 0, y: 0 });
  shot.nodes = [
    {
      id: 'outside',
      type: 'asset',
      assetId: 'source',
      name: '角色参考',
      width: 400,
      height: 320,
      position: { x: -400, y: 100 },
    },
    { id: 'a', type: 'text', text: 'first', position: { x: 200, y: 200 } },
    { id: 'b', type: 'text', text: 'second', position: { x: 500, y: 200 } },
    {
      id: 'unrelated',
      type: 'text',
      text: 'other',
      position: { x: 1000, y: 800 },
    },
  ];
  return groupMaterials(shot, ['a', 'b'], 'target');
}

test('hover join retains target identity, settings and existing coordinates; appends references in order', () => {
  const original = sample();
  videoGroup(original.groups[0]).parameters.duration = 12;
  const before = structuredClone(original);
  const next = joinMaterials(original, ['outside'], 'target');
  assert.deepEqual(original, before);
  assert.equal(next.groups.length, 1);
  assert.deepEqual(
    required(next.groups[0]).position,
    required(original.groups[0]).position,
  );
  assert.deepEqual(
    required(next.groups[0]).parameters,
    required(original.groups[0]).parameters,
  );
  assert.equal(required(next.groups[0]).id, 'target');
  for (const id of ['a', 'b', 'unrelated'])
    assert.deepEqual(
      next.nodes.find((node) => node.id === id),
      original.nodes.find((node) => node.id === id),
    );
  const added = required(next.nodes.find((node) => node.id === 'outside'));
  assert.deepEqual(
    {
      ...added,
      groupId: undefined,
      position: required(before.nodes[0]).position,
    },
    { ...before.nodes[0], groupId: undefined },
  );
  assert.deepEqual(
    next.nodes
      .filter((node) => node.groupId === 'target')
      .map((node) => node.id),
    ['a', 'b', 'outside'],
  );
  const size = materialSize(added);
  assert.ok(
    added.position.y + size.height + 20 <= required(next.groups[0]).height,
  );
  assert.ok(
    added.position.x + size.width + 20 <= required(next.groups[0]).width,
  );
  for (const node of next.nodes.filter((node) =>
    ['a', 'b'].includes(node.id),
  )) {
    const other = materialSize(node);
    assert.ok(
      added.position.x >= node.position.x + other.width ||
        added.position.x + size.width <= node.position.x ||
        added.position.y >= node.position.y + other.height ||
        added.position.y + size.height <= node.position.y,
    );
  }
  validateWorkspace({ ...emptyWorkspace(), shots: [next] });
  assert.equal(
    joinMaterials(next, ['outside'], 'target'),
    next,
    'replayed join is a no-op',
  );
});

test('hover target uses pointer position and excludes grouped nodes, labels, unknown IDs and full groups', () => {
  const shot = sample();
  const group = required(shot.groups[0]);
  const point = { x: group.position.x + 30, y: group.position.y + 30 };
  assert.equal(materialHoverGroup(shot, ['outside'], point)?.id, 'target');
  assert.equal(
    materialHoverGroup(shot, ['outside'], { x: -100, y: -100 }),
    undefined,
  );
  for (const ids of [
    [],
    ['a'],
    ['target'],
    ['unknown'],
    ['outside', 'unknown'],
  ]) {
    assert.equal(canJoinMaterials(shot, ids, 'target'), false);
    assert.equal(joinMaterials(shot, ids, 'target'), shot);
  }
  for (let i = 0; i < 30; i++)
    shot.nodes.push({
      id: `member-${i}`,
      type: 'text',
      text: '',
      groupId: 'target',
      position: { x: 20, y: 52 },
    });
  assert.equal(materialHoverGroup(shot, ['outside'], point), undefined);
  assert.equal(joinMaterials(shot, ['outside'], 'target'), shot);
});

test('joining multiple loose cards neither overlaps nor duplicates the incoming references', () => {
  const shot = sample();
  const next = joinMaterials(
    shot,
    ['outside', 'unrelated', 'outside'],
    'target',
  );
  assert.equal(next.nodes.length, shot.nodes.length);
  assert.ok(next.nodes.every((node) => node.groupId === 'target'));
  assert.deepEqual(
    next.nodes.map((node) => node.id),
    ['a', 'b', 'outside', 'unrelated'],
  );
  validateWorkspace({ ...emptyWorkspace(), shots: [next] });
});
