import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Library } from '../src/main/storage/library';
import {
  emptyGenerationDraft,
  validateGenerationDraft,
} from '../src/shared/generation/draft';
import { referenceKind } from '../src/shared/generation/reference-files';
import type { Asset } from '../src/shared/models';

async function fixture() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-generation-')),
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

async function addReference(
  library: Library,
  projectId: string,
  kind: Asset['kind'],
  contents = '测试素材',
) {
  const extension = { image: 'png', video: 'mp4', audio: 'mp3', text: 'txt' }[
    kind
  ];
  const job = await library.acceptResult(
    {
      projectId,
      resultKey: `reference:${kind}`,
      name: `素材.${extension}`,
      kind,
      usage: 'reference',
      extension,
    },
    Readable.from(Buffer.from(contents)),
  );
  await library.saves.idle();
  return job.id;
}

test('legacy projects have an empty draft; reference imports stay outside the main canvas and survive migration', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const { project } = await f.library.projects.create('生成草稿');
  assert.deepEqual(
    await f.library.generation.read(project.id),
    emptyGenerationDraft(),
  );
  const referenceIds = [];
  for (const kind of ['text', 'image', 'video', 'audio'] as const)
    referenceIds.push(await addReference(f.library, project.id, kind));
  const video = await f.library.acceptResult(
    {
      projectId: project.id,
      resultKey: 'canvas-video',
      name: '画布.mp4',
      kind: 'video',
      extension: 'mp4',
    },
    Readable.from('video'),
  );
  await f.library.saves.idle();
  const snapshot = await f.library.projects.open(project.id);
  assert.equal(snapshot.assets.length, 5);
  assert.equal(snapshot.canvas.cards.length, 1);
  assert.deepEqual(snapshot.canvas.cards[0]?.assetIds, [video.id]);
  const draft = await f.library.generation.save(project.id, {
    ...emptyGenerationDraft(),
    prompt: '清晨的海边',
    referenceIds,
  });
  assert.equal(draft.revision, 1);
  const textId = referenceIds[0];
  assert.ok(textId);
  assert.equal(
    await f.library.generation.readText(project.id, textId),
    '测试素材',
  );
  const target = join(f.base, 'moved');
  await mkdir(target);
  const preview = await f.library.migration.prepare(target);
  await f.library.migration.start(preview.token);
  await f.library.migration.idle();
  assert.equal(
    f.library.state().migration?.phase,
    'completed',
    JSON.stringify(f.library.state().migration),
  );
  assert.deepEqual(await f.library.generation.read(project.id), draft);
  const moved = await f.library.projects.open(project.id);
  for (const asset of moved.assets.filter(
    (item) => item.usage === 'reference',
  )) {
    assert.equal(
      await readFile(join(target, project.id, asset.relativePath), 'utf8'),
      '测试素材',
    );
  }
  assert.equal(
    await f.library.generation.readText(project.id, textId),
    '测试素材',
  );
  assert.equal(moved.canvas.cards.length, 1);
});

test('draft saves reject stale revisions and foreign references without replacing the current prompt', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const first = await f.library.projects.create('一');
  const second = await f.library.projects.create('二');
  const foreignId = await addReference(f.library, second.project.id, 'text');
  const initial = emptyGenerationDraft();
  await assert.rejects(
    f.library.generation.save(first.project.id, {
      ...initial,
      referenceIds: [foreignId],
    }),
    /不属于/,
  );
  await assert.rejects(
    f.library.generation.readText(first.project.id, foreignId),
    /不存在/,
  );
  const saved = await f.library.generation.save(first.project.id, {
    ...initial,
    prompt: '当前正文',
  });
  await assert.rejects(
    f.library.generation.save(first.project.id, {
      ...initial,
      prompt: '过时正文',
    }),
    /已在其他页面更新/,
  );
  assert.deepEqual(await f.library.generation.read(first.project.id), saved);
});

test('references arriving during migration remain staged and can be saved on release', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const { project } = await f.library.projects.create('等待保存');
  await f.library.gate.block();
  const id = await addReference(f.library, project.id, 'audio');
  assert.equal(f.library.store.job(id).status, 'ready');
  await assert.rejects(
    f.library.generation.save(project.id, {
      ...emptyGenerationDraft(),
      referenceIds: [id],
    }),
    /迁移/,
  );
  assert.equal((await f.library.projects.open(project.id)).assets.length, 0);
  f.library.gate.release();
  // The draft may reference the durable staging ID before the queue commits it.
  await f.library.generation.save(project.id, {
    ...emptyGenerationDraft(),
    referenceIds: [id],
  });
  f.library.saves.kick();
  await f.library.saves.idle();
  assert.equal(f.library.store.job(id).status, 'saved');
  assert.deepEqual((await f.library.generation.read(project.id)).referenceIds, [
    id,
  ]);
  assert.equal(
    (await f.library.projects.open(project.id)).canvas.cards.length,
    0,
  );
});

test('Seedance draft validation keeps fast model parameters consistent and rejects malformed drafts', () => {
  const draft = emptyGenerationDraft();
  assert.deepEqual(validateGenerationDraft(draft), draft);
  for (const parameters of [
    { ...draft.parameters, duration: 3 },
    { ...draft.parameters, duration: 16 },
    { ...draft.parameters, ratio: 'unknown' },
    { ...draft.parameters, generateAudio: 'yes' },
    { ...draft.parameters, model: 'seedance-2.0-fast', resolution: '1080p' },
  ])
    assert.throws(
      () => validateGenerationDraft({ ...draft, parameters }),
      /无效/,
    );
  assert.equal(
    validateGenerationDraft({
      ...draft,
      parameters: { ...draft.parameters, duration: -1 },
    }).parameters.duration,
    -1,
  );
  assert.throws(
    () => validateGenerationDraft({ ...draft, prompt: 'a'.repeat(10001) }),
    /无效/,
  );
  assert.equal(referenceKind('JPG'), 'image');
  assert.equal(referenceKind('md'), 'text');
  assert.equal(referenceKind('m4a'), 'audio');
  assert.equal(referenceKind('html'), null);
});

test('text references require UTF-8 and a bounded size', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const { project } = await f.library.projects.create('文本约束');
  const id = await addReference(
    f.library,
    project.id,
    'text',
    'a'.repeat(1024 * 1024 + 1),
  );
  await assert.rejects(f.library.generation.readText(project.id, id), /1 MB/);
  const invalid = await f.library.acceptResult(
    {
      projectId: project.id,
      resultKey: 'invalid-utf8',
      name: 'bad.txt',
      kind: 'text',
      usage: 'reference',
      extension: 'txt',
    },
    Readable.from(Buffer.from([0xff, 0xfe, 0x12])),
  );
  await f.library.saves.idle();
  await assert.rejects(
    f.library.generation.readText(project.id, invalid.id),
    /UTF-8/,
  );
});
