// Historical writer contract: only import code from the pinned historical checkout.
// Keep existing scenarios when adding a release; never regenerate them with current code.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const [source, directory, mode] = process.argv.slice(2);
assert.ok(source && directory);
assert.ok(
  ['legacy-draft', 'material-workspace', 'image-workspace'].includes(mode),
);
const { Library } = await import(
  pathToFileURL(join(source, 'src/main/storage/library.ts')).href
);
const root = join(directory, '用户项目 with spaces');
const library = await Library.open(join(directory, 'app'), root);

async function add(projectId, key, kind, content, usage) {
  const extension = { video: 'mp4', image: 'png', audio: 'wav', text: 'txt' }[
    kind
  ];
  const job = await library.acceptResult(
    {
      projectId,
      resultKey: key,
      name: `历史素材-${key}.${extension}`,
      kind,
      extension,
      ...(usage ? { usage } : {}),
    },
    Readable.from(Buffer.from(content)),
  );
  await library.saves.idle();
  assert.equal(library.store.job(job.id).status, 'saved');
  return job.id;
}

try {
  const { project } = await library.projects.create('历史项目：雨夜 🌧');
  const second = await library.projects.create('独立项目，不能被覆盖');
  const pending = await library.projects.create('升级前尚未保存的结果');
  const videos = [];
  for (let index = 0; index < 3; index++)
    videos.push(
      await add(
        project.id,
        `video-${index}`,
        'video',
        `synthetic video ${index}`,
      ),
    );
  const references = [];
  for (const kind of ['image', 'audio', 'text'])
    references.push(
      await add(
        project.id,
        kind,
        kind,
        `合成${kind}源文件\n不可改写`,
        'reference',
      ),
    );
  await add(second.project.id, 'independent', 'video', 'independent bytes');
  const before = await library.projects.open(project.id);
  await library.projects.patchCanvas(project.id, {
    before: before.canvas.cards,
    after: [
      {
        id: randomUUID(),
        position: { x: -240.5, y: 812.25 },
        assetIds: [videos[2], videos[0], videos[1]],
        trims: {
          [videos[0]]: { start: 1.25, end: 9.75 },
          [videos[2]]: { start: 3.5, end: 12.125 },
        },
      },
    ],
  });
  await library.projects.update(project.id, {
    viewport: { x: -123.5, y: 77.25, zoom: 0.65 },
  });
  const parameters = {
    model: 'seedance-2.0',
    ratio: '9:16',
    resolution: '1080p',
    duration: 12,
    generateAudio: false,
  };
  const draft = await library.generation.save(project.id, {
    version: 1,
    revision: 0,
    prompt: '历史提示词\n雨夜中的人物走向镜头。保留中文与 emoji 🎬',
    referenceIds: references,
    parameters,
  });
  let workspace = null;
  if (mode === 'material-workspace' || mode === 'image-workspace') {
    const shot = {
      id: 'shot-one',
      name: '已生成镜头',
      sourceAssetId: videos[1],
      position: { x: 123, y: -456 },
      viewport: { x: -90, y: 30, zoom: 1.25 },
      nodes: [
        {
          id: 'text-two',
          type: 'text',
          text: '先保留这一段\n第二行',
          name: '独立标题',
          width: 360,
          height: 300,
          position: { x: 20, y: 40 },
          groupId: 'group-one',
        },
        {
          id: 'text-one',
          type: 'text',
          text: '再保留第二段，不按 ID 排序',
          position: { x: 320, y: 40 },
          groupId: 'group-one',
        },
        ...references.map((assetId, index) => ({
          id: `reference-${index}`,
          type: 'asset',
          assetId,
          position: { x: 20 + index * 280, y: 400 },
          groupId: 'group-two',
          ...(index === 2
            ? { textOverride: '修改后的文本，不覆盖源文件' }
            : {}),
        })),
      ],
      groups: [
        {
          id: 'group-one',
          position: { x: 0, y: 0 },
          width: 760,
          height: 340,
          parameters,
        },
        {
          id: 'group-two',
          position: { x: 0, y: 360 },
          width: 900,
          height: 400,
          parameters: {
            ...parameters,
            model: 'seedance-2.0-fast',
            resolution: '480p',
            ratio: '16:9',
            duration: 4,
            generateAudio: true,
          },
        },
      ],
      labels: [
        {
          id: 'label-one',
          name: '远处的场景',
          color: '#f59e0b',
          pinned: true,
          position: { x: 5000, y: -3000 },
        },
      ],
    };
    if (mode === 'image-workspace') {
      // Add to the established material scenario without changing its video groups,
      // source references, labels, node order, or missing legacy kind fields.
      shot.groups.push(
        {
          id: 'image-text-group',
          kind: 'image',
          position: { x: 1100, y: 0 },
          width: 700,
          height: 360,
          parameters: {
            model: 'seedream-5.0-lite',
            ratio: '3:2',
            resolution: '3K',
          },
        },
        {
          id: 'image-reference-group',
          kind: 'image',
          position: { x: 1100, y: 500 },
          width: 900,
          height: 440,
          parameters: {
            model: 'seedream-4.5',
            ratio: '9:16',
            resolution: '4K',
          },
        },
      );
      shot.nodes.push(
        {
          id: 'image-text-prompt',
          type: 'text',
          text: '文生图：雨后的街道\n保留画面描述 🎨',
          name: '图片提示词',
          width: 400,
          height: 280,
          position: { x: 20, y: 60 },
          groupId: 'image-text-group',
        },
        {
          id: 'image-reference',
          type: 'asset',
          assetId: references[0],
          name: '图片组的独立参考名',
          width: 320,
          height: 320,
          position: { x: 20, y: 60 },
          groupId: 'image-reference-group',
        },
        {
          id: 'image-reference-prompt',
          type: 'text',
          text: '图生图：保持参考构图，改为黄昏。',
          position: { x: 360, y: 60 },
          groupId: 'image-reference-group',
        },
        {
          id: 'image-reference-text-file',
          type: 'asset',
          assetId: references[2],
          textOverride: '图片组文本覆盖，与视频组和源文件独立',
          position: { x: 640, y: 60 },
          groupId: 'image-reference-group',
        },
      );
    }
    workspace = await library.generation.saveWorkspace(project.id, {
      version: 1,
      revision: 0,
      shots: [
        shot,
        {
          id: 'shot-two',
          name: '待生成镜头',
          position: { x: -600, y: 400 },
          viewport: { x: 0, y: 0, zoom: 0.5 },
          nodes: [],
          groups: [],
        },
      ],
    });
    if (mode === 'image-workspace') {
      // Fail if the pinned writer already loses image fields; a broken historical
      // round trip must never become the expected manifest for the current reader.
      assert.deepEqual(workspace.shots[0], shot);
    }
  }
  const settings = library.interactions.get();
  settings.longPressSplit = false;
  settings.shortcuts.play = { key: 'p', mod: false, shift: false, alt: false };
  settings.shortcuts.redo = null;
  if (mode === 'material-workspace' || mode === 'image-workspace')
    settings.shortcuts.locateLabels = null;
  library.interactions.save(settings);
  await mkdir(join(root, '用户自己放的文件'));
  await writeFile(
    join(root, '用户自己放的文件', '说明.txt'),
    '不能清理的用户文件',
  );

  // Leave a real durable result in staging, as when the old app exits before saving.
  await library.gate.block();
  const queued = await library.acceptResult(
    {
      projectId: pending.project.id,
      resultKey: 'upgrade-pending',
      name: '升级前结果.mp4',
      kind: 'video',
      extension: 'mp4',
    },
    Readable.from('synthetic pending bytes'),
  );
  assert.equal(queued.status, 'ready');
  const manifest = {
    mode,
    root,
    projects: [
      await library.projects.open(project.id),
      await library.projects.open(second.project.id),
    ],
    queued,
    jobs: library.store.jobs(),
    pendingProject: pending.project,
    settings,
    draft,
    workspace,
  };
  await writeFile(
    join(directory, 'expected.json'),
    JSON.stringify(manifest, null, 2),
  );
} finally {
  await library.close();
}
