import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendGroupText,
  editMaterialText,
  reorderGroupMembers,
} from '../src/shared/generation/group-editing';
import { detachMaterial } from '../src/shared/generation/material-groups';
import { resizeMaterial } from '../src/shared/generation/node-geometry';
import { ShotHistory } from '../src/shared/generation/shot-history';
import {
  groupMaterials,
  newShot,
  removeMaterial,
  type ShotWorkspace,
} from '../src/shared/generation/workspace';

function sample(id = 'one'): ShotWorkspace {
  return {
    ...newShot(id, '镜头', { x: 20, y: 40 }, 'source-video'),
    nodes: [
      {
        id: 'text',
        type: 'text',
        text: '自写文本不能丢',
        position: { x: 100, y: 100 },
      },
      {
        id: 'reference',
        type: 'asset',
        assetId: 'reference-file',
        textOverride: '文件文字的独立改动',
        position: { x: 400, y: 100 },
      },
    ],
    labels: [
      {
        id: 'label',
        name: '标记',
        color: '#336699',
        pinned: true,
        position: { x: 800, y: 700 },
      },
    ],
  };
}

test('each shot has independent undo/redo; restored content never rolls back routing or either canvas camera', () => {
  const history = new ShotHistory();
  const one = sample();
  const two = sample('two');
  const removed = removeMaterial(one, 'text');
  history.record(one, removed);
  const renamed = { ...two, name: '第二个镜头' };
  history.record(two, renamed);
  const moved = {
    ...removed,
    position: { x: 900, y: 800 },
    viewport: { x: 350, y: 150, zoom: 0.5 },
    sourceAssetId: 'latest-video',
  };
  history.record(removed, moved);
  const restored = history.undo(moved);
  assert.deepEqual(restored.nodes, one.nodes);
  assert.deepEqual(restored.position, moved.position);
  assert.deepEqual(restored.viewport, moved.viewport);
  assert.equal(restored.sourceAssetId, moved.sourceAssetId);
  assert.equal(history.state('two').canUndo, true);
  assert.equal(history.undo(renamed).name, two.name);
  assert.deepEqual(history.redo(restored), moved);
});

test('group, detach, reorder, resize and imported references remain atomic reversible edits', () => {
  const history = new ShotHistory();
  let current = sample();
  const operations = [
    (shot: ShotWorkspace) =>
      groupMaterials(shot, ['text', 'reference'], 'group'),
    (shot: ShotWorkspace) =>
      appendGroupText(shot, 'group', 'extra-text', '新增文本'),
    (shot: ShotWorkspace) =>
      reorderGroupMembers(shot, 'group', ['extra-text', 'reference', 'text']),
    (shot: ShotWorkspace) =>
      resizeMaterial(shot, 'text', { width: 440, height: 360 }),
    (shot: ShotWorkspace) =>
      detachMaterial(shot, 'reference', { x: 900, y: 600 }),
    (shot: ShotWorkspace) => ({
      ...shot,
      nodes: [
        ...shot.nodes,
        {
          id: 'imported',
          type: 'asset' as const,
          assetId: 'disk-file-that-is-not-deleted',
          position: { x: 1200, y: 100 },
        },
      ],
    }),
  ];
  const states = [structuredClone(current)];
  for (const operation of operations) {
    const next = operation(current);
    history.record(current, next);
    current = next;
    states.push(structuredClone(current));
  }
  for (let i = states.length - 2; i >= 0; i--) {
    current = history.undo(current);
    assert.deepEqual(current, states[i]);
  }
  assert.equal(history.state(current.id).canUndo, false);
  for (let i = 1; i < states.length; i++) {
    current = history.redo(current);
    assert.deepEqual(current, states[i]);
  }
});

test('continuous edits coalesce by control and time, and blur/new branches split history', () => {
  const history = new ShotHistory();
  const initial = sample();
  const a = editMaterialText(initial, 'text', 'a');
  history.record(initial, a, { mergeKey: 'text:text' }, 100);
  const ab = editMaterialText(a, 'text', 'ab');
  history.record(a, ab, { mergeKey: 'text:text' }, 200);
  const abc = editMaterialText(ab, 'text', 'abc');
  history.record(ab, abc, { mergeKey: 'text:text' }, 300);
  assert.deepEqual(history.undo(abc), initial);
  const restored = history.redo(initial);
  assert.deepEqual(restored, abc);
  history.breakMerge(initial.id);
  const next = editMaterialText(restored, 'text', 'new gesture');
  history.record(restored, next, { mergeKey: 'text:text' }, 400);
  assert.deepEqual(history.undo(next), abc);
  const other = editMaterialText(abc, 'reference', '新的文件引用内容');
  history.record(abc, other, { mergeKey: 'text:reference' }, 450);
  assert.equal(history.state(initial.id).canRedo, false);
  assert.deepEqual(history.undo(other), abc);
  const delayed = editMaterialText(abc, 'text', '停顿后的文本');
  history.record(abc, delayed, { mergeKey: 'text:text' }, 2500);
  assert.deepEqual(history.undo(delayed), abc);
});

test('parameter edits restore each group independently without changing absent legacy kind or labels', () => {
  const history = new ShotHistory();
  const base = groupMaterials(sample(), ['text'], 'group');
  const change = (shot: ShotWorkspace, duration: number) => ({
    ...shot,
    groups: shot.groups.map((group) =>
      group.kind !== 'image'
        ? { ...group, parameters: { ...group.parameters, duration } }
        : group,
    ),
  });
  const six = change(base, 6);
  history.record(base, six, { mergeKey: 'parameters:group' }, 100);
  const seven = change(six, 7);
  history.record(six, seven, { mergeKey: 'parameters:group' }, 200);
  assert.deepEqual(history.undo(seven), base);
  assert.equal(base.groups[0]?.kind, undefined);
  const empty = newShot('empty', '无标签', { x: 0, y: 0 });
  const labelled = { ...empty, labels: [] };
  history.record(empty, labelled);
  assert.equal(Object.hasOwn(history.undo(labelled), 'labels'), false);
});

test('automatic placeholder setup and viewport-only updates do not create undo steps or clear redo', () => {
  const history = new ShotHistory();
  const original = sample();
  const grouped = groupMaterials(original, ['reference'], 'group');
  history.record(original, grouped);
  const placeholder = appendGroupText(grouped, 'group', 'automatic');
  history.record(grouped, placeholder, { record: false });
  const undone = history.undo(placeholder);
  assert.deepEqual(undone, original);
  const viewport = { ...undone, viewport: { x: 555, y: 333, zoom: 0.8 } };
  history.record(undone, viewport);
  assert.equal(history.state(original.id).canRedo, true);
  const redone = history.redo(viewport);
  assert.deepEqual(redone.nodes, placeholder.nodes);
  assert.deepEqual(redone.viewport, viewport.viewport);
  assert.equal(history.state(original.id).canRedo, false);
});

test('history snapshots are isolated and bounded; stale snapshots cannot mutate later undo', () => {
  const history = new ShotHistory(2);
  let current = sample();
  for (let i = 0; i < 4; i++) {
    const next = { ...current, name: `名称${i}` };
    history.record(current, next);
    current = next;
  }
  current = history.undo(current);
  assert.equal(current.name, '名称2');
  current = history.undo(current);
  assert.equal(current.name, '名称1');
  assert.equal(history.state(current.id).canUndo, false);
  const restored = history.redo(current);
  const node = restored.nodes[0];
  assert.ok(node && node.type === 'text');
  node.text = '不能污染历史';
  const again = history.undo(restored);
  assert.equal(
    again.nodes[0]?.type === 'text' && again.nodes[0].text,
    '自写文本不能丢',
  );
  const tiny = new ShotHistory(50, 1);
  tiny.record(current, { ...current, name: 'too large' });
  assert.equal(tiny.state(current.id).canUndo, false);
});
