import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { Library } from '../src/main/storage/library';
import { duplicateShot } from '../src/shared/generation/shot-duplication';
import {
  emptyWorkspace,
  groupMaterials,
  newShot,
} from '../src/shared/generation/workspace';
import type { Asset } from '../src/shared/models';

test('copied shots retain shared asset references and independent names, text, parameters and source association through SQLite saves and two reopens', async () => {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-shot-reuse-')),
  );
  const app = join(base, 'app');
  const root = join(base, 'projects');
  let library = await Library.open(app, root);
  try {
    const { project } = await library.projects.create('镜头复用存储');
    const independent = await library.projects.create('无关项目不能改变');
    const add = async (
      kind: Asset['kind'],
      content: Buffer,
      usage?: Asset['usage'],
    ) => {
      const extension = {
        video: 'mp4',
        image: 'svg',
        text: 'txt',
        audio: 'wav',
      }[kind];
      const job = await library.acceptResult(
        {
          projectId: project.id,
          resultKey: `shot-reuse:${kind}`,
          name: `原始素材.${extension}`,
          kind,
          extension,
          ...(usage ? { usage } : {}),
        },
        Readable.from(content),
      );
      await library.saves.idle();
      assert.equal(library.store.job(job.id).status, 'saved');
      return job.id;
    };
    // Storage fixture bytes; this test does not claim video decode validation.
    const videoId = await add('video', Buffer.from('synthetic saved video'));
    const imageId = await add(
      'image',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>',
      ),
      'reference',
    );
    const textId = await add(
      'text',
      Buffer.from('源文件分镜，不得改写。'),
      'reference',
    );
    const snapshot = await library.projects.open(project.id);
    const original = newShot('original', '雨夜镜头', { x: 40, y: 80 }, videoId);
    original.nodes.push(
      {
        id: 'dialogue',
        type: 'text',
        text: '原镜头对白',
        name: '对白',
        position: { x: 400, y: 100 },
      },
      {
        id: 'reference-text',
        type: 'asset',
        assetId: textId,
        textOverride: '镜头内分镜修改',
        position: { x: 700, y: 100 },
      },
      {
        id: 'image-prompt',
        type: 'text',
        text: '图片组描述',
        position: { x: 400, y: 500 },
      },
      {
        id: 'reference-image',
        type: 'asset',
        assetId: imageId,
        position: { x: 700, y: 500 },
      },
    );
    original.labels = [
      {
        id: 'label',
        name: '固定位置',
        color: '#2563eb',
        pinned: true,
        position: { x: 900, y: 900 },
      },
    ];
    let source = groupMaterials(
      original,
      ['dialogue', 'reference-text'],
      'video-group',
    );
    source = groupMaterials(
      source,
      ['image-prompt', 'reference-image'],
      'image-group',
      undefined,
      { kind: 'image', assets: snapshot.assets },
    );
    const independentWorkspace = {
      ...emptyWorkspace(),
      shots: [newShot('independent-shot', '无关镜头', { x: 0, y: 0 })],
    };
    const savedIndependent = await library.generation.saveWorkspace(
      independent.project.id,
      independentWorkspace,
    );
    const independentFile = join(
      root,
      independent.project.folder,
      'project.sqlite',
    );
    const independentBytes = await readFile(independentFile);
    const sourceFiles = await Promise.all(
      snapshot.assets.map(async (asset) => {
        const file = join(root, project.folder, asset.relativePath);
        const bytes = await readFile(file);
        assert.equal(
          createHash('sha256').update(bytes).digest('hex'),
          asset.sha256,
        );
        return { file, bytes };
      }),
    );
    const first = await library.generation.saveWorkspace(project.id, {
      ...emptyWorkspace(),
      shots: [source],
    });
    const sourceBeforeCopy = structuredClone(source);
    const copy = duplicateShot(source, first.shots, { x: 580, y: 80 });
    assert.notEqual(copy.id, source.id);
    assert.equal(copy.sourceAssetId, undefined);
    assert.deepEqual(
      copy.nodes
        .filter((node) => node.type === 'asset')
        .map((node) => node.assetId),
      source.nodes
        .filter((node) => node.type === 'asset')
        .map((node) => node.assetId),
    );
    copy.name = '独立副本 🌙';
    const copiedText = copy.nodes.find((node) => node.type === 'text');
    assert.ok(copiedText?.type === 'text');
    copiedText.text = '仅副本修改的对白';
    for (const group of copy.groups) {
      if (group.kind === 'image') group.parameters.ratio = '1:1';
      else group.parameters.duration = 9;
    }
    assert.deepEqual(source, sourceBeforeCopy);
    const renamedSource = { ...source, name: '原镜头单独改名' };
    const submitted = { ...first, shots: [renamedSource, copy] };
    const expected = { ...submitted, revision: first.revision + 1 };
    assert.deepEqual(
      await library.generation.saveWorkspace(project.id, submitted),
      expected,
    );
    for (let index = 0; index < 2; index++) {
      await library.close();
      library = await Library.open(app, join(base, 'unused-default'));
      const reopened = await library.generation.readWorkspace(project.id);
      assert.deepEqual(reopened, expected);
      assert.equal(reopened.shots[0]?.sourceAssetId, videoId);
      assert.equal(
        Object.hasOwn(reopened.shots[1] ?? {}, 'sourceAssetId'),
        false,
      );
      assert.deepEqual(
        (await library.projects.open(project.id)).assets,
        snapshot.assets,
      );
      assert.deepEqual(
        await library.generation.readWorkspace(independent.project.id),
        savedIndependent,
      );
      assert.deepEqual(await readFile(independentFile), independentBytes);
      for (const file of sourceFiles)
        assert.deepEqual(await readFile(file.file), file.bytes);
    }
  } finally {
    await library.close();
    await rm(base, { recursive: true, force: true });
  }
});
