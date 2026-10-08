import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildMaterialSearchEntries,
  filterMaterialSearchEntries,
  materialSearchTarget,
} from '../src/renderer/src/features/generation/search/material-search-model';
import { emptyGenerationDraft } from '../src/shared/generation/draft';
import { defaultImageParameters } from '../src/shared/generation/image-generation';
import { newShot } from '../src/shared/generation/workspace';
import type { Asset } from '../src/shared/models';

function fixture() {
  const shot = newShot('shot', '镜头一', { x: 800, y: 900 });
  shot.nodes = [
    {
      id: 'text',
      type: 'text',
      name: '对白',
      text: `${'开场'.repeat(80)}雨后重逢`,
      position: { x: 5, y: 7 },
    },
    {
      id: 'copy-one',
      type: 'asset',
      assetId: 'image',
      name: '主角特写',
      position: { x: 25, y: 60 },
      groupId: 'video-group',
      width: 400,
      height: 220,
    },
    {
      id: 'copy-two',
      type: 'asset',
      assetId: 'image',
      name: '远景人物',
      position: { x: 30, y: 400 },
      groupId: 'image-group',
    },
    {
      id: 'edited-file',
      type: 'asset',
      assetId: 'text-file',
      name: '对白修订',
      textOverride: '晚霞里的秘密',
      position: { x: 500, y: 20 },
      groupId: 'video-group',
    },
    {
      id: 'pending',
      type: 'asset',
      assetId: 'not-yet-saved',
      name: '待保存参考',
      position: { x: 2, y: 3 },
    },
  ];
  shot.groups = [
    {
      id: 'video-group',
      position: { x: -300, y: 200 },
      width: 950,
      height: 600,
      parameters: emptyGenerationDraft().parameters,
    },
    {
      id: 'image-group',
      kind: 'image',
      position: { x: 1200, y: -100 },
      width: 500,
      height: 700,
      parameters: defaultImageParameters(),
    },
  ];
  shot.labels = [
    {
      id: 'label',
      name: '夜景区',
      color: '#2563eb',
      pinned: true,
      position: { x: -90, y: -50 },
    },
  ];
  const assets: Asset[] = [
    {
      id: 'image',
      name: 'Ｈｅｒｏ ０１.png',
      relativePath: 'assets/images/hero.png',
      size: 100,
      sha256: 'a'.repeat(64),
      kind: 'image',
      usage: 'reference',
    },
    {
      id: 'text-file',
      name: '剧本.txt',
      relativePath: 'assets/notes.txt',
      size: 30,
      sha256: 'b'.repeat(64),
      kind: 'text',
      usage: 'reference',
    },
    {
      id: 'unused',
      name: '其他镜头图片.png',
      relativePath: 'assets/unused.png',
      size: 20,
      sha256: 'c'.repeat(64),
      kind: 'image',
    },
  ];
  return { shot, assets };
}

test('instance aliases remain independent while source names use normalized multiword search', () => {
  const { shot, assets } = fixture();
  const entries = buildMaterialSearchEntries(shot, assets);
  assert.deepEqual(
    filterMaterialSearchEntries(entries, '  主角   hero 01 ', 'image').map(
      (entry) => entry.id,
    ),
    ['copy-one'],
  );
  assert.deepEqual(
    filterMaterialSearchEntries(entries, 'ＨＥＲＯ', 'image').map(
      (entry) => entry.id,
    ),
    ['copy-one', 'copy-two'],
  );
  assert.equal(
    entries.find((entry) => entry.id === 'copy-two')?.name,
    '远景人物',
  );
  assert.deepEqual(
    filterMaterialSearchEntries(entries, '主角 远景', 'image'),
    [],
  );
  assert.equal(
    entries.some((entry) => entry.id === 'unused'),
    false,
  );
});

test('full editable text and group contents remain searchable beyond display excerpts', () => {
  const { shot, assets } = fixture();
  const entries = buildMaterialSearchEntries(shot, assets);
  assert.deepEqual(
    filterMaterialSearchEntries(entries, '雨后重逢').map((entry) => entry.id),
    ['text'],
  );
  assert.deepEqual(
    filterMaterialSearchEntries(entries, '剧本 秘密', 'text').map(
      (entry) => entry.id,
    ),
    ['edited-file'],
  );
  assert.deepEqual(
    filterMaterialSearchEntries(entries, '视频生成 晚霞', 'group').map(
      (entry) => entry.id,
    ),
    ['video-group'],
  );
  assert.deepEqual(
    filterMaterialSearchEntries(entries, '图片生成 远景', 'group').map(
      (entry) => entry.id,
    ),
    ['image-group'],
  );
  assert.equal(
    shot.groups[0]?.kind,
    undefined,
    'reading legacy video groups never rewrites their kind',
  );
});

test('targets include parent-group coordinates and actual dimensions, without changing the shot', () => {
  const { shot, assets } = fixture();
  const before = structuredClone({ shot, assets });
  const member = materialSearchTarget(shot, assets, 'copy-one');
  assert.deepEqual(member?.position, { x: -275, y: 260 });
  assert.equal(member?.width, 400);
  assert.equal(member?.height, 220);
  assert.match(member?.context ?? '', /位于视频生成组 1/);
  const group = materialSearchTarget(shot, assets, 'video-group');
  assert.deepEqual(group?.position, { x: -300, y: 200 });
  assert.equal(group?.width, 950);
  const label = materialSearchTarget(shot, assets, 'label');
  assert.deepEqual(label?.position, { x: -90, y: -50 });
  assert.equal(label?.width, 220);
  assert.equal(label?.height, 52);
  assert.deepEqual({ shot, assets }, before);
});

test('filters include labels and unavailable instances; clearing restores all current entries', () => {
  const { shot, assets } = fixture();
  const entries = buildMaterialSearchEntries(shot, assets);
  assert.deepEqual(
    filterMaterialSearchEntries(entries, '夜景', 'label').map(
      (entry) => entry.id,
    ),
    ['label'],
  );
  assert.deepEqual(
    filterMaterialSearchEntries(entries, '待保存', 'unavailable').map(
      (entry) => entry.id,
    ),
    ['pending'],
  );
  assert.deepEqual(filterMaterialSearchEntries(entries, '不存在'), []);
  assert.deepEqual(filterMaterialSearchEntries(entries, '　\n'), entries);
  assert.deepEqual(
    filterMaterialSearchEntries(
      buildMaterialSearchEntries(
        newShot('empty', '空镜头', { x: 0, y: 0 }),
        [],
      ),
      '',
    ),
    [],
  );
});

test('choosing uses fresh target geometry and does not retarget a removed instance to its shared asset', () => {
  const { shot, assets } = fixture();
  const changed = {
    ...shot,
    groups: shot.groups.map((group) => ({
      ...group,
      position: { x: 900, y: 700 },
    })),
  };
  assert.deepEqual(
    materialSearchTarget(changed, assets, 'copy-one')?.position,
    { x: 925, y: 760 },
  );
  const removed = {
    ...shot,
    nodes: shot.nodes.filter((node) => node.id !== 'copy-one'),
  };
  assert.equal(materialSearchTarget(removed, assets, 'copy-one'), null);
  assert.equal(
    materialSearchTarget(removed, assets, 'copy-two')?.name,
    '远景人物',
  );
  assert.equal(materialSearchTarget(shot, assets, 'not-a-node'), null);
});
