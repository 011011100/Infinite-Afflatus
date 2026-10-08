import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyGenerationDraft } from '../src/shared/generation/draft';
import { MAX_SHOTS } from '../src/shared/generation/shot-duplication';
import {
  applyShotListOperation,
  type ShotListOperation,
} from '../src/shared/generation/shot-list-operations';
import {
  emptyWorkspace,
  newShot,
  validateWorkspace,
} from '../src/shared/generation/workspace';
import type { ShotWorkspace } from '../src/shared/generation/workspace-types';

function sample(id: string): ShotWorkspace {
  return {
    ...newShot(id, `镜头 ${id}`, { x: 50, y: 100 }, `video-${id}`),
    viewport: { x: -120, y: 80, zoom: 0.75 },
    groups: [
      {
        id: `group-${id}`,
        position: { x: 700, y: -200 },
        width: 700,
        height: 400,
        parameters: {
          ...emptyGenerationDraft().parameters,
          duration: 12,
          generateAudio: false,
        },
      },
    ],
    nodes: [
      {
        id: `text-${id}`,
        type: 'text',
        text: '完整分镜\n第二段 🌊',
        name: '第一块文字',
        width: 360,
        height: 300,
        groupId: `group-${id}`,
        position: { x: 24, y: 52 },
      },
      {
        id: `reference-${id}`,
        type: 'asset',
        assetId: 'shared-text-asset',
        textOverride: '仅在镜头内修改的参考文本',
        position: { x: -500, y: 200 },
      },
    ],
    labels: [
      {
        id: `label-${id}`,
        name: '固定位置',
        color: '#3366ff',
        pinned: true,
        position: { x: -200, y: -300 },
      },
    ],
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('inserting and removing a shot preserve exact list order and unrelated live references', () => {
  const first = sample('first');
  const last = sample('last');
  const input = freeze([first, last]);
  const original = structuredClone(input);
  const inserted = sample('middle');
  const result = applyShotListOperation(input, {
    type: 'insert',
    shot: inserted,
    index: 1,
  });
  assert.ok(result);
  assert.deepEqual(
    result.shots.map((shot) => shot.id),
    ['first', 'middle', 'last'],
  );
  assert.equal(result.shots[0], first);
  assert.equal(result.shots[2], last);
  assert.deepEqual(result.shots[1], inserted);
  assert.notEqual(result.shots[1], inserted);
  inserted.name = '改变操作参数不改变已插入镜头';
  inserted.viewport.x = 3000;
  assert.equal(result.shots[1]?.name, '镜头 middle');
  assert.equal(result.shots[1]?.viewport.x, -120);
  const removed = applyShotListOperation(result.shots, result.inverse);
  assert.ok(removed);
  assert.deepEqual(removed.shots, input);
  assert.equal(removed.shots[0], first);
  assert.equal(removed.shots[1], last);
  assert.equal(removed.inverse.type, 'insert');
  assert.deepEqual(input, original);
});

test('undoing creation captures the latest content for redo without rolling back another shot', () => {
  const other = sample('other');
  const created = newShot('created', '新建镜头', { x: 400, y: 300 });
  const creation = applyShotListOperation([other], {
    type: 'insert',
    shot: created,
    index: 1,
  });
  assert.ok(creation);
  const latest = {
    ...sample('created'),
    name: '创建后编辑的名称',
    viewport: { x: 700, y: -100, zoom: 1.5 },
  };
  delete latest.sourceAssetId;
  const otherLatest = { ...other, name: '另一镜头的新内容' };
  const undo = applyShotListOperation([otherLatest, latest], creation.inverse);
  assert.ok(undo?.inverse.type === 'insert');
  assert.equal(undo.shots[0], otherLatest);
  assert.equal(undo.inverse.index, 1);
  assert.deepEqual(undo.inverse.shot, latest);
  assert.notEqual(undo.inverse.shot, latest);
  const before = structuredClone(undo.inverse);
  latest.name = '已移除对象上的后续改动不能污染历史';
  latest.nodes.reverse();
  assert.deepEqual(undo.inverse, before);
  const redo = applyShotListOperation(undo.shots, undo.inverse);
  assert.ok(redo);
  assert.equal(redo.shots[0], otherLatest);
  assert.deepEqual(redo.shots[1], before.shot);
  assert.notEqual(redo.shots[1], before.shot);
  assert.deepEqual(redo.inverse, { type: 'remove', id: created.id });
});

test('move undo changes only position after newer name, text and viewport edits', () => {
  const target = freeze(sample('moving'));
  const other = freeze(sample('other'));
  const operation: ShotListOperation = {
    type: 'move',
    id: target.id,
    from: { ...target.position },
    to: { x: -550, y: 800 },
  };
  const moved = applyShotListOperation([other, target], freeze(operation));
  assert.ok(moved?.inverse.type === 'move');
  const after = moved.shots[1];
  assert.ok(after);
  assert.equal(moved.shots[0], other);
  assert.equal(after.nodes, target.nodes);
  assert.equal(after.groups, target.groups);
  assert.equal(after.labels, target.labels);
  assert.deepEqual(after.position, operation.to);
  assert.notEqual(after.position, operation.to);
  assert.notEqual(moved.inverse.from, after.position);
  assert.notEqual(moved.inverse.to, target.position);
  const latest: ShotWorkspace = {
    ...after,
    name: '移动后继续命名',
    viewport: { x: 0, y: 1000, zoom: 2 },
    nodes: [
      ...after.nodes,
      {
        id: 'new-text',
        type: 'text',
        text: '新内容',
        position: { x: 50, y: 70 },
      },
    ],
  };
  const undone = applyShotListOperation([other, latest], moved.inverse);
  assert.ok(undone?.inverse.type === 'move');
  assert.equal(undone.shots[0], other);
  assert.deepEqual(undone.shots[1], { ...latest, position: target.position });
  assert.equal(undone.shots[1]?.nodes, latest.nodes);
  assert.deepEqual(undone.inverse, operation);
});

test('remove and restore retain full legacy shapes, source association and fixed labels', () => {
  const before = sample('before');
  const target = sample('target');
  const after = sample('after');
  const original = structuredClone(target);
  const removal = applyShotListOperation(freeze([before, target, after]), {
    type: 'remove',
    id: target.id,
  });
  assert.ok(removal?.inverse.type === 'insert');
  assert.deepEqual(removal.inverse.shot, original);
  assert.ok(!Object.hasOwn(removal.inverse.shot.groups[0] ?? {}, 'kind'));
  assert.equal(removal.inverse.shot.sourceAssetId, 'video-target');
  assert.equal(removal.inverse.shot.labels?.[0]?.pinned, true);
  const restored = applyShotListOperation(removal.shots, removal.inverse);
  assert.ok(restored);
  assert.deepEqual(restored.shots, [before, original, after]);
  assert.equal(restored.shots[0], before);
  assert.equal(restored.shots[2], after);
  assert.deepEqual(
    validateWorkspace({ ...emptyWorkspace(), shots: restored.shots }).shots,
    restored.shots,
  );
});

test('insert respects the final live capacity slot and never evicts a shot for an undo', () => {
  const shots = Array.from({ length: MAX_SHOTS - 1 }, (_, index) =>
    newShot(`existing-${index}`, `镜头 ${index}`, { x: index, y: 0 }),
  );
  const target = sample('restored');
  const operation: ShotListOperation = {
    type: 'insert',
    shot: target,
    index: 40,
  };
  const result = applyShotListOperation(shots, operation);
  assert.ok(result);
  assert.equal(result.shots.length, MAX_SHOTS);
  assert.deepEqual(result.shots[40], target);
  const full = freeze(result.shots);
  const before = structuredClone(full);
  assert.throws(
    () =>
      applyShotListOperation(full, {
        type: 'insert',
        shot: sample('overflow'),
        index: 0,
      }),
    /500 个镜头/,
  );
  assert.deepEqual(full, before);
  assert.equal(shots.length, MAX_SHOTS - 1);
});

test('invalid indexes, duplicate identities and source associations reject without changes', () => {
  const existing = sample('existing');
  const shots = freeze([existing]);
  const before = structuredClone(shots);
  for (const index of [-1, 0.5, 2, Infinity, NaN])
    assert.throws(
      () =>
        applyShotListOperation(shots, {
          type: 'insert',
          shot: sample('new'),
          index,
        }),
      /插入位置无效/,
    );
  assert.throws(
    () =>
      applyShotListOperation(shots, {
        type: 'insert',
        shot: sample('existing'),
        index: 1,
      }),
    /已存在/,
  );
  assert.throws(
    () =>
      applyShotListOperation(shots, {
        type: 'insert',
        shot: { ...sample('new'), sourceAssetId: 'video-existing' },
        index: 1,
      }),
    /已关联其他镜头/,
  );
  const malformed = sample('invalid');
  const node = malformed.nodes[0];
  assert.ok(node);
  node.groupId = 'missing-group';
  assert.throws(
    () =>
      applyShotListOperation(shots, {
        type: 'insert',
        shot: malformed,
        index: 1,
      }),
    /生成组|无效/,
  );
  assert.deepEqual(shots, before);
});

test('moves require the current position and valid coordinates; only a matched zero move is a no-op', () => {
  const shot = sample('target');
  const shots = freeze([shot]);
  const before = structuredClone(shots);
  assert.equal(
    applyShotListOperation(shots, {
      type: 'move',
      id: shot.id,
      from: { ...shot.position },
      to: { ...shot.position },
    }),
    null,
  );
  const rejected: ShotListOperation[] = [
    { type: 'remove', id: 'missing' },
    { type: 'move', id: 'missing', from: { x: 0, y: 0 }, to: { x: 0, y: 0 } },
    {
      type: 'move',
      id: shot.id,
      from: { x: 51, y: 100 },
      to: { x: 70, y: 100 },
    },
    {
      type: 'move',
      id: shot.id,
      from: { x: 51, y: 100 },
      to: { x: 51, y: 100 },
    },
    ...[Infinity, NaN, 1e8, -1e8].map((x) => ({
      type: 'move' as const,
      id: shot.id,
      from: { ...shot.position },
      to: { x, y: 0 },
    })),
  ];
  for (const operation of rejected)
    assert.throws(
      () => applyShotListOperation(shots, operation),
      /不存在|已变化|坐标无效/,
    );
  assert.deepEqual(shots, before);
});
