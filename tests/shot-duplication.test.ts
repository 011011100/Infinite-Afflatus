import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyGenerationDraft } from '../src/shared/generation/draft';
import { defaultImageParameters } from '../src/shared/generation/image-generation';
import {
  duplicateShot,
  MAX_SHOTS,
} from '../src/shared/generation/shot-duplication';
import {
  emptyWorkspace,
  newShot,
  validateWorkspace,
} from '../src/shared/generation/workspace';
import type { ShotWorkspace } from '../src/shared/generation/workspace-types';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sample(): ShotWorkspace {
  return {
    ...newShot('source-shot', '海边镜头', { x: 140, y: 250 }, 'video-asset'),
    viewport: { x: -240, y: 125, zoom: 0.75 },
    groups: [
      {
        id: 'legacy-group',
        position: { x: -500, y: 40 },
        width: 750,
        height: 380,
        parameters: {
          ...emptyGenerationDraft().parameters,
          duration: 12,
          generateAudio: false,
        },
      },
      {
        id: 'image-group',
        kind: 'image',
        position: { x: 350, y: 200 },
        width: 860,
        height: 400,
        parameters: { ...defaultImageParameters(), ratio: '16:9' },
      },
      {
        id: 'video-group',
        kind: 'video',
        position: { x: 350, y: 750 },
        width: 650,
        height: 370,
        parameters: { ...emptyGenerationDraft().parameters, ratio: '9:16' },
      },
    ],
    nodes: [
      {
        id: 'legacy-text',
        type: 'text',
        text: '第一行\n第二行 🌊',
        name: '分镜正文',
        width: 380,
        height: 300,
        groupId: 'legacy-group',
        position: { x: 25, y: 60 },
      },
      {
        id: 'image-reference',
        type: 'asset',
        assetId: 'image-asset',
        groupId: 'image-group',
        position: { x: 24, y: 52 },
        width: 420,
        name: '海面参考',
      },
      {
        id: 'image-prompt',
        type: 'asset',
        assetId: 'text-asset',
        textOverride: '单独编辑的提示词',
        groupId: 'image-group',
        position: { x: 470, y: 52 },
      },
      {
        id: 'video-reference',
        type: 'asset',
        assetId: 'video-asset',
        groupId: 'video-group',
        position: { x: 24, y: 52 },
      },
      {
        id: 'loose-reference',
        type: 'asset',
        assetId: 'text-asset',
        textOverride: '',
        height: 280,
        position: { x: -700, y: -200 },
      },
    ],
    labels: [
      {
        id: 'pinned-label',
        name: '已确定',
        color: '#12abEF',
        pinned: true,
        position: { x: -250, y: -500 },
      },
      {
        id: 'loose-label',
        name: '候选方向',
        color: '#ff9900',
        pinned: false,
        position: { x: 1500, y: 300 },
      },
    ],
  };
}

function ids(shot: ShotWorkspace) {
  return [
    shot.id,
    ...shot.groups.map((group) => group.id),
    ...shot.nodes.map((node) => node.id),
    ...(shot.labels ?? []).map((label) => label.id),
  ];
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('shot duplication remaps every editing identity and group reference while retaining exact content', () => {
  const source = sample();
  const original = structuredClone(source);
  const position = freeze({ x: 1100, y: -320 });
  const copy = duplicateShot(freeze(source), freeze([source]), position);
  assert.deepEqual(source, original);
  assert.equal(copy.name, '海边镜头 副本');
  assert.deepEqual(copy.position, position);
  assert.notEqual(copy.position, position);
  assert.ok(!Object.hasOwn(copy, 'sourceAssetId'));
  const originalIds = new Set(ids(source));
  assert.equal(new Set(ids(copy)).size, ids(copy).length);
  for (const id of ids(copy)) {
    assert.match(id, uuid);
    assert.ok(!originalIds.has(id));
  }
  const groupIds = new Map(
    copy.groups.map((group, index) => [group.id, source.groups[index]?.id]),
  );
  assert.ok(source.sourceAssetId);
  assert.ok(copy.labels);
  const restored: ShotWorkspace = {
    ...copy,
    id: source.id,
    name: source.name,
    position: source.position,
    sourceAssetId: source.sourceAssetId,
    groups: copy.groups.map((group, index) => ({
      ...group,
      id: source.groups[index]?.id ?? '',
    })),
    nodes: copy.nodes.map((node, index) => {
      const restoredNode = { ...node, id: source.nodes[index]?.id ?? '' };
      if (node.groupId !== undefined) {
        const groupId = groupIds.get(node.groupId);
        assert.ok(groupId);
        restoredNode.groupId = groupId;
      }
      return restoredNode;
    }),
    labels: copy.labels.map((label, index) => ({
      ...label,
      id: source.labels?.[index]?.id ?? '',
    })),
  };
  assert.deepEqual(restored, source);
  assert.ok(!Object.hasOwn(copy.groups[0] ?? {}, 'kind'));
  assert.equal(copy.groups[1]?.kind, 'image');
  assert.equal(copy.groups[2]?.kind, 'video');
  assert.deepEqual(
    validateWorkspace({ ...emptyWorkspace(), shots: [source, copy] }).shots,
    [source, copy],
  );
});

test('independent copies never share nested editing objects or change source fields', () => {
  const source = sample();
  const original = structuredClone(source);
  const first = duplicateShot(source, [source], { x: 600, y: 400 });
  const second = duplicateShot(source, [source, first], { x: 900, y: 400 });
  const secondBefore = structuredClone(second);
  assert.equal(second.name, '海边镜头 副本 2');
  assert.ok(ids(second).every((id) => !new Set(ids(first)).has(id)));
  first.viewport.x = 77;
  first.position.x = 88;
  const text = first.nodes[0];
  assert.ok(text?.type === 'text');
  text.text = '只改副本';
  text.name = '副本标题';
  text.position.y = 999;
  text.width = 700;
  const asset = first.nodes[2];
  assert.ok(asset?.type === 'asset');
  asset.textOverride = '副本覆盖文本';
  const group = first.groups[0];
  assert.ok(group && group.kind !== 'image');
  group.parameters.duration = 7;
  group.position.x = -2000;
  const label = first.labels?.[0];
  assert.ok(label);
  label.name = '副本标签';
  label.color = '#000000';
  label.pinned = false;
  label.position.x = 42;
  first.groups.pop();
  first.nodes.reverse();
  first.labels?.pop();
  assert.deepEqual(source, original);
  assert.deepEqual(second, secondBefore);
});

test('legacy optional field shapes and an empty shot remain unchanged by duplication', () => {
  const source = newShot('empty', '空镜头', { x: 0, y: 0 });
  const copy = duplicateShot(source, [source], { x: 400, y: 0 });
  assert.deepEqual(copy.nodes, []);
  assert.deepEqual(copy.groups, []);
  assert.ok(!Object.hasOwn(copy, 'labels'));
  assert.ok(!Object.hasOwn(copy, 'sourceAssetId'));

  const legacy = sample();
  const group = legacy.groups[0];
  assert.ok(group && group.kind !== 'image');
  assert.ok(Reflect.set(group, 'kind', undefined));
  const withUndefined = duplicateShot(legacy, [legacy], { x: 800, y: 0 });
  assert.ok(Object.hasOwn(withUndefined.groups[0] ?? {}, 'kind'));
  assert.equal(withUndefined.groups[0]?.kind, undefined);
});

test('copy names stay unique after truncation, ordinal growth and emoji boundaries', () => {
  const source = newShot('long-name', '镜'.repeat(100), { x: 0, y: 0 });
  const firstName = `${'镜'.repeat(97)} 副本`;
  const secondName = `${'镜'.repeat(95)} 副本 2`;
  const shots = [
    source,
    newShot('copy-one', firstName, { x: 0, y: 0 }),
    newShot('copy-two', secondName, { x: 0, y: 0 }),
  ];
  const third = duplicateShot(source, shots, { x: 400, y: 0 });
  assert.equal(third.name, `${'镜'.repeat(95)} 副本 3`);
  assert.equal(third.name.length, 100);
  assert.ok(shots.every((shot) => shot.name !== third.name));
  const emojis = newShot('emoji-name', '🌊'.repeat(50), { x: 0, y: 0 });
  const emojiCopy = duplicateShot(emojis, [emojis], { x: 400, y: 0 });
  assert.equal(emojiCopy.name, `${'🌊'.repeat(48)} 副本`);
  assert.ok(emojiCopy.name.length <= 100);
  assert.doesNotThrow(() => encodeURIComponent(emojiCopy.name));

  const ordinalSource = newShot('ordinal', '镜头', { x: 0, y: 0 });
  const prior = Array.from({ length: 9 }, (_, index) =>
    newShot(
      `prior-${index}`,
      index === 0 ? '镜头 副本' : `镜头 副本 ${index + 1}`,
      { x: 0, y: 0 },
    ),
  );
  assert.equal(
    duplicateShot(ordinalSource, [ordinalSource, ...prior], { x: 0, y: 0 })
      .name,
    '镜头 副本 10',
  );
});

test('the last available shot slot is usable and a full project rejects without mutation', () => {
  const shots = Array.from({ length: MAX_SHOTS - 1 }, (_, index) =>
    newShot(`shot-${index}`, `镜头 ${index}`, { x: index * 20, y: 0 }),
  );
  const source = shots[0];
  assert.ok(source);
  const before = structuredClone(shots);
  const last = duplicateShot(source, shots, { x: 20000, y: 0 });
  assert.deepEqual(shots, before);
  assert.equal(
    validateWorkspace({ ...emptyWorkspace(), shots: [...shots, last] }).shots
      .length,
    MAX_SHOTS,
  );
  const full = freeze([...shots, last]);
  const fullBefore = structuredClone(full);
  assert.throws(
    () => duplicateShot(source, full, { x: 21000, y: 0 }),
    /500 个镜头/,
  );
  assert.deepEqual(full, fullBefore);
});

test('invalid group references or destination positions reject instead of dropping content', () => {
  const source = sample();
  const node = source.nodes[0];
  assert.ok(node);
  node.groupId = 'missing-group';
  const before = structuredClone(source);
  assert.throws(
    () => duplicateShot(source, [source], { x: 400, y: 0 }),
    /无效|生成组/,
  );
  assert.deepEqual(source, before);
  const valid = freeze(sample());
  const validBefore = structuredClone(valid);
  assert.throws(
    () => duplicateShot(valid, [valid], { x: Infinity, y: 0 }),
    /无效/,
  );
  assert.deepEqual(valid, validBefore);
});
