import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Library } from '../src/main/storage/library';
import { emptyGenerationDraft } from '../src/shared/generation/draft';
import {
  defaultImageParameters,
  type ImageInputAsset,
  imageInputError,
  imageReferenceCount,
  validateImageParameters,
} from '../src/shared/generation/image-generation';
import {
  canJoinMaterials,
  joinMaterials,
  materialHoverGroup,
} from '../src/shared/generation/join-materials';
import {
  detachMaterial,
  materialSelection,
} from '../src/shared/generation/material-groups';
import {
  emptyWorkspace,
  type GenerationGroup,
  groupMaterials,
  type MaterialNode,
  newShot,
  ungroupMaterials,
  validateWorkspace,
  workspaceFromDraft,
} from '../src/shared/generation/workspace';

const assets: ImageInputAsset[] = [
  { id: 'picture', kind: 'image' },
  { id: 'prompt-file', kind: 'text' },
  { id: 'movie', kind: 'video' },
  { id: 'sound', kind: 'audio' },
];
function imageGroup(group: GenerationGroup | undefined) {
  assert.ok(group?.kind === 'image');
  return group;
}
function sample() {
  const shot = newShot('shot', '图片与视频', { x: 0, y: 0 });
  shot.nodes = [
    {
      id: 'prompt',
      type: 'text',
      text: '海边的灯塔 🌊',
      name: '镜头描述',
      width: 400,
      position: { x: 80, y: 100 },
    },
    ...assets.map((asset, index) => ({
      id: asset.id,
      type: 'asset' as const,
      assetId: asset.id,
      ...(asset.kind === 'text' ? { textOverride: '编辑后的文本' } : {}),
      position: { x: 600 + index * 300, y: 100 },
    })),
  ];
  return shot;
}

test('image parameters reject mismatched models and resolutions; legacy groups retain their exact shape', () => {
  assert.deepEqual(validateImageParameters(defaultImageParameters()), {
    model: 'seedream-5.0-lite',
    ratio: '1:1',
    resolution: '2K',
  });
  for (const resolution of ['2K', '3K', '4K'])
    assert.equal(
      validateImageParameters({ ...defaultImageParameters(), resolution })
        .resolution,
      resolution,
    );
  for (const parameters of [
    { ...defaultImageParameters(), model: 'seedance-2.0' },
    { ...defaultImageParameters(), resolution: '720p' },
    { ...defaultImageParameters(), ratio: 'invalid' },
    { ...defaultImageParameters(), model: 'seedream-4.5', resolution: '3K' },
    null,
  ])
    assert.throws(() => validateImageParameters(parameters), /图片生成参数/);
  const legacy = workspaceFromDraft('project', {
    ...emptyGenerationDraft(),
    prompt: '旧视频提示词',
  });
  assert.ok(!Object.hasOwn(legacy.shots[0]?.groups[0] ?? {}, 'kind'));
  assert.deepEqual(validateWorkspace(legacy), legacy);
  const invalid = structuredClone(legacy) as unknown as {
    shots: { groups: { kind: string }[] }[];
  };
  const group = invalid.shots[0]?.groups[0];
  assert.ok(group);
  group.kind = 'audio';
  assert.throws(() => validateWorkspace(invalid), /类型无效/);
});

test('image input count follows actual references and rejects unavailable, video, audio and over-limit inputs', () => {
  const shot = sample();
  const text = shot.nodes.filter((node) =>
    ['prompt', 'prompt-file'].includes(node.id),
  );
  assert.equal(imageInputError(text, assets), null);
  assert.equal(imageReferenceCount(text, assets), 0);
  const picture = shot.nodes.find((node) => node.id === 'picture');
  assert.ok(picture);
  assert.equal(imageInputError([...text, picture], assets), null);
  assert.equal(imageReferenceCount([...text, picture], assets), 1);
  for (const id of ['movie', 'sound'])
    assert.match(
      imageInputError(
        shot.nodes.filter((node) => node.id === id),
        assets,
      ) ?? '',
      /只支持文本和图片/,
    );
  assert.match(imageInputError([picture], []) ?? '', /尚未就绪或不存在/);
  const pictures = Array.from({ length: 15 }, (_, index) => ({
    ...picture,
    id: `reference-${index}`,
  }));
  assert.equal(imageInputError(pictures.slice(0, 14), assets), null);
  assert.match(imageInputError(pictures, assets) ?? '', /14 张参考图/);
});

test('image group creation and same-kind merging preserve settings, text, references, and independent video groups', () => {
  let shot = groupMaterials(sample(), ['prompt', 'picture'], 'image-a', null, {
    kind: 'image',
    assets,
  });
  shot = groupMaterials(shot, ['prompt-file'], 'image-b', null, {
    kind: 'image',
    assets,
  });
  shot = groupMaterials(shot, ['movie'], 'video');
  const first = imageGroup(shot.groups[0]);
  const second = imageGroup(shot.groups[1]);
  first.parameters = { model: 'seedream-4.5', ratio: '3:2', resolution: '4K' };
  second.parameters.ratio = '9:16';
  const before = structuredClone(shot);
  const fallback = groupMaterials(
    shot,
    ['image-b', 'image-a'],
    'fallback',
    null,
    {
      assets,
    },
  );
  assert.deepEqual(imageGroup(fallback.groups[1]).parameters, first.parameters);
  const merged = groupMaterials(
    shot,
    ['image-a', 'image-b'],
    'merged',
    'image-b',
    {
      assets,
    },
  );
  assert.deepEqual(imageGroup(merged.groups[1]).parameters, second.parameters);
  assert.deepEqual(merged.groups[0], before.groups[2]);
  assert.deepEqual(
    merged.nodes.map(({ position: _, groupId: __, ...node }) => node),
    before.nodes.map(({ position: _, groupId: __, ...node }) => node),
  );
  assert.deepEqual(shot, before);
  validateWorkspace({ ...emptyWorkspace(), shots: [merged] });
  imageGroup(merged.groups[1]).parameters.ratio = '4:3';
  assert.equal(second.parameters.ratio, '9:16');
});

test('cross-kind merges, implicit conversions and invalid image members cannot discard existing data', () => {
  let shot = groupMaterials(sample(), ['prompt'], 'image', null, {
    kind: 'image',
  });
  shot = groupMaterials(shot, ['movie'], 'video');
  const before = structuredClone(shot);
  const selection = materialSelection(shot, ['image', 'video']);
  assert.equal(selection.mixedKinds, true);
  assert.equal(selection.canGroup, false);
  assert.throws(
    () => groupMaterials(shot, ['image', 'video'], 'mixed'),
    /不能直接合并/,
  );
  assert.throws(
    () =>
      groupMaterials(shot, ['image', 'picture'], 'converted', null, {
        kind: 'video',
        assets,
      }),
    /更改已有组的生成类型/,
  );
  assert.throws(
    () => groupMaterials(shot, ['image', 'sound'], 'invalid', null, { assets }),
    /只支持文本和图片/,
  );
  assert.deepEqual(shot, before);
});

test('hover joins apply image input limits before confirmation and preserve target parameters through detach/rejoin', () => {
  let shot = groupMaterials(sample(), ['prompt'], 'image', null, {
    kind: 'image',
  });
  const target = imageGroup(shot.groups[0]);
  target.parameters = {
    model: 'seedream-4.5',
    ratio: '16:9',
    resolution: '4K',
  };
  const point = { x: target.position.x + 10, y: target.position.y + 10 };
  for (const id of ['movie', 'sound']) {
    assert.equal(canJoinMaterials(shot, [id], 'image', assets), false);
    assert.equal(materialHoverGroup(shot, [id], point, assets), undefined);
    assert.equal(joinMaterials(shot, [id], 'image', assets), shot);
  }
  assert.equal(canJoinMaterials(shot, ['picture'], 'image'), false);
  assert.equal(
    materialHoverGroup(shot, ['picture'], point, assets)?.id,
    'image',
  );
  const originalText = shot.nodes[0];
  shot = joinMaterials(shot, ['picture'], 'image', assets);
  assert.equal(
    imageReferenceCount(
      shot.nodes.filter((node) => node.groupId === 'image'),
      assets,
    ),
    1,
  );
  assert.deepEqual(shot.nodes[0], originalText);
  assert.deepEqual(shot.groups[0]?.parameters, target.parameters);
  shot = detachMaterial(shot, 'picture');
  assert.equal(
    imageReferenceCount(
      shot.nodes.filter((node) => node.groupId === 'image'),
      assets,
    ),
    0,
  );
  assert.deepEqual(shot.groups[0]?.parameters, target.parameters);
  shot = joinMaterials(shot, ['picture'], 'image', assets);
  assert.deepEqual(shot.groups[0]?.parameters, target.parameters);
  const dissolved = ungroupMaterials(shot, 'image');
  assert.ok(dissolved.nodes.every((node) => !node.groupId));
  assert.equal(dissolved.nodes.length, shot.nodes.length);

  const picture = shot.nodes.find((node) => node.id === 'picture');
  assert.ok(picture);
  shot.nodes.push(
    ...Array.from({ length: 13 }, (_, i) => ({
      ...picture,
      id: `member-${i}`,
    })),
  );
  const { groupId: _, ...loosePicture } = picture;
  shot.nodes.push({ ...loosePicture, id: 'extra' });
  assert.equal(canJoinMaterials(shot, ['extra'], 'image', assets), false);
  assert.equal(materialHoverGroup(shot, ['extra'], point, assets), undefined);
  assert.equal(joinMaterials(shot, ['extra'], 'image', assets), shot);
});

async function fixture() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-image-groups-')),
  );
  const library = await Library.open(join(base, 'app'), join(base, 'projects'));
  return {
    base,
    library,
    async dispose() {
      await library.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('SQLite reopens independent image/video settings and rejects invalid image references without overwriting saved work', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const { project } = await f.library.projects.create('图片和视频草稿');
  const picture = await f.library.acceptResult(
    {
      projectId: project.id,
      resultKey: 'picture',
      name: '参考.png',
      kind: 'image',
      usage: 'reference',
      extension: 'png',
    },
    Readable.from('synthetic image storage bytes'),
  );
  const video = await f.library.acceptResult(
    {
      projectId: project.id,
      resultKey: 'video',
      name: '参考.mp4',
      kind: 'video',
      usage: 'reference',
      extension: 'mp4',
    },
    Readable.from('synthetic video storage bytes'),
  );
  await f.library.saves.idle();
  let shot = newShot('shot', '分镜 01', { x: 100, y: 100 });
  shot.nodes = [
    { id: 'prompt', type: 'text', text: '静物光影', position: { x: 0, y: 0 } },
    {
      id: 'picture',
      type: 'asset',
      assetId: picture.id,
      position: { x: 300, y: 0 },
    },
    {
      id: 'video',
      type: 'asset',
      assetId: video.id,
      position: { x: 600, y: 0 },
    },
  ];
  const available = (await f.library.projects.open(project.id)).assets;
  shot = groupMaterials(shot, ['prompt', 'picture'], 'image', null, {
    kind: 'image',
    assets: available,
  });
  shot = groupMaterials(shot, ['video'], 'video-group');
  imageGroup(shot.groups[0]).parameters = {
    model: 'seedream-4.5',
    ratio: '3:4',
    resolution: '4K',
  };
  const videoGroup = shot.groups[1];
  assert.ok(videoGroup && videoGroup.kind !== 'image');
  videoGroup.parameters.duration = 12;
  const saved = await f.library.generation.saveWorkspace(project.id, {
    ...emptyWorkspace(),
    shots: [shot],
  });
  const invalid = structuredClone(saved);
  const invalidShot = invalid.shots[0];
  assert.ok(invalidShot);
  const invalidNode = invalidShot.nodes.find((node) => node.id === 'picture');
  assert.ok(invalidNode?.type === 'asset');
  invalidNode.assetId = video.id;
  await assert.rejects(
    f.library.generation.saveWorkspace(project.id, invalid),
    /只支持文本和图片/,
  );
  const crowded = structuredClone(saved);
  const crowdedShot = crowded.shots[0];
  assert.ok(crowdedShot);
  const original = crowdedShot.nodes.find((node) => node.id === 'picture');
  assert.ok(original);
  crowdedShot.nodes.push(
    ...Array.from({ length: 14 }, (_, i) => ({
      ...original,
      id: `extra-${i}`,
    })),
  );
  await assert.rejects(
    f.library.generation.saveWorkspace(project.id, crowded),
    /14 张参考图/,
  );
  assert.deepEqual(await f.library.generation.readWorkspace(project.id), saved);
  await f.library.close();
  const reopened = await Library.open(
    join(f.base, 'app'),
    join(f.base, 'projects'),
  );
  try {
    assert.deepEqual(
      await reopened.generation.readWorkspace(project.id),
      saved,
    );
    assert.equal(
      (await reopened.projects.open(project.id)).canvas.cards.length,
      0,
    );
  } finally {
    await reopened.close();
  }
});

test('image workspace validation accepts durable staged references before their project save finishes', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const { project } = await f.library.projects.create('暂存图片');
  await f.library.saves.idle();
  const picture = await f.library.staging.receive(
    {
      projectId: project.id,
      resultKey: 'staged-picture',
      name: '参考.png',
      kind: 'image',
      usage: 'reference',
      extension: 'png',
    },
    Readable.from('durable synthetic image'),
  );
  assert.equal((await f.library.projects.open(project.id)).assets.length, 0);
  let shot = newShot('shot', '暂存镜头', { x: 0, y: 0 });
  const node: MaterialNode = {
    id: 'picture',
    type: 'asset',
    assetId: picture.id,
    position: { x: 0, y: 0 },
  };
  shot.nodes = [node];
  shot = groupMaterials(shot, ['picture'], 'image', null, {
    kind: 'image',
    assets: [{ id: picture.id, kind: 'image' }],
  });
  const saved = await f.library.generation.saveWorkspace(project.id, {
    ...emptyWorkspace(),
    shots: [shot],
  });
  assert.deepEqual(await f.library.generation.readWorkspace(project.id), saved);
  f.library.saves.kick();
  await f.library.saves.idle();
  assert.equal(f.library.store.job(picture.id).status, 'saved');
});
