import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Library } from '../src/main/storage/library';
import { emptyGenerationDraft } from '../src/shared/generation/draft';
import { detachMaterial } from '../src/shared/generation/material-groups';
import { materialPosition } from '../src/shared/generation/material-layout';
import {
  emptyWorkspace,
  groupMaterials,
  newShot,
  removeMaterial,
  ungroupMaterials,
  validateWorkspace,
  workspaceFromDraft,
} from '../src/shared/generation/workspace';

function sample() {
  const shot = newShot('shot', '镜头', { x: 40, y: 80 });
  shot.nodes = ['one', 'two', 'three'].map((id, i) => ({
    id,
    type: 'text',
    text: id,
    position: { x: 80 + i * 300, y: 100 },
  }));
  return shot;
}

test('group only selected materials; moving and dissolving a group preserves absolute positions and other groups', () => {
  const original = sample();
  const grouped = groupMaterials(original, ['one', 'two'], 'group-one');
  assert.deepEqual(grouped.nodes[2], original.nodes[2]);
  assert.equal(grouped.nodes[0]?.groupId, 'group-one');
  const both = groupMaterials(grouped, ['three'], 'group-two');
  const first = both.groups[0];
  assert.ok(first);
  first.position = { x: 700, y: 800 };
  first.parameters.duration = 12;
  assert.equal(both.groups[1]?.parameters.duration, 5);
  const dissolved = ungroupMaterials(both, 'group-one');
  assert.deepEqual(dissolved.nodes[0]?.position, { x: 720, y: 852 });
  assert.deepEqual(dissolved.nodes[1]?.position, { x: 996, y: 852 });
  assert.equal(dissolved.nodes[0]?.groupId, undefined);
  assert.equal(dissolved.nodes[2]?.groupId, 'group-two');
  assert.equal(dissolved.groups.length, 1);
  assert.deepEqual(original.nodes[0]?.position, { x: 80, y: 100 });
  const removed = removeMaterial(both, 'three');
  assert.deepEqual(
    removed.groups.map((group) => group.id),
    ['group-one'],
  );
});

test('new material placement avoids existing cards and generation panels', () => {
  const shot = groupMaterials(sample(), ['one', 'two'], 'group');
  const at = materialPosition(shot, { x: 400, y: 200 }, 3);
  for (const rect of [
    { ...shot.groups[0]?.position, width: 872, height: 316 },
    { x: 680, y: 100, width: 260, height: 244 },
  ]) {
    assert.ok(
      at.x + 828 <= (rect.x ?? 0) ||
        at.x >= (rect.x ?? 0) + rect.width ||
        at.y + 244 <= (rect.y ?? 0) ||
        at.y >= (rect.y ?? 0) + rect.height,
    );
  }
});

test('legacy drafts convert every reference and prompt while preserving model parameters', () => {
  const draft = {
    ...emptyGenerationDraft(),
    prompt: '晨光从窗外照进来',
    referenceIds: Array.from({ length: 24 }, (_, i) => `asset-${i}`),
  };
  draft.parameters.duration = 9;
  const workspace = workspaceFromDraft('project', draft);
  assert.deepEqual(validateWorkspace(workspace), workspace);
  assert.equal(workspace.shots[0]?.nodes.length, 25);
  assert.equal(workspace.shots[0]?.groups[0]?.parameters.duration, 9);
  assert.ok(
    workspace.shots[0]?.nodes.some(
      (node) => node.type === 'text' && node.text === draft.prompt,
    ),
  );
  assert.deepEqual(
    workspaceFromDraft('project', emptyGenerationDraft()),
    emptyWorkspace(),
  );
});

test('workspace validation rejects duplicate identities, dangling groups and invalid parameters', () => {
  const shot = groupMaterials(sample(), ['one'], 'group');
  const base = { ...emptyWorkspace(), shots: [shot] };
  assert.deepEqual(validateWorkspace(base), base);
  assert.throws(
    () => validateWorkspace({ ...base, shots: [shot, shot] }),
    /无效/,
  );
  assert.throws(
    () =>
      validateWorkspace({
        ...base,
        shots: [{ ...shot, nodes: [...shot.nodes, shot.nodes[0]] }],
      }),
    /无效/,
  );
  assert.throws(
    () => validateWorkspace({ ...base, shots: [{ ...shot, groups: [] }] }),
    /无效/,
  );
  assert.throws(
    () =>
      validateWorkspace({
        ...base,
        shots: [{ ...shot, viewport: { x: 0, y: 0, zoom: 0 } }],
      }),
    /无效/,
  );
  const bad = structuredClone(base);
  const first = bad.shots[0]?.groups[0];
  assert.ok(first);
  first.parameters.duration = 100;
  assert.throws(() => validateWorkspace(bad), /无效/);
});

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'afflatus-shots-')));
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
async function reference(library: Library, projectId: string, key: string) {
  const job = await library.acceptResult(
    {
      projectId,
      resultKey: key,
      name: '文本.txt',
      kind: 'text',
      usage: 'reference',
      extension: 'txt',
    },
    Readable.from('镜头参考'),
  );
  await library.saves.idle();
  return job.id;
}

test('SQLite saves independent shots, rejects stale/foreign edits, preserves legacy conversion and migrates the workspace', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const { project } = await f.library.projects.create('素材子画布');
  const other = await f.library.projects.create('另一个项目');
  const own = await reference(f.library, project.id, 'own');
  const foreign = await reference(f.library, other.project.id, 'foreign');
  await f.library.generation.save(project.id, {
    ...emptyGenerationDraft(),
    prompt: '原始草稿',
    referenceIds: [own],
  });
  const converted = await f.library.generation.readWorkspace(project.id);
  assert.equal(converted.shots[0]?.nodes.length, 2);
  const doc = { ...converted, shots: [...converted.shots, sample()] };
  const saved = await f.library.generation.saveWorkspace(project.id, doc);
  assert.equal(saved.revision, 1);
  await assert.rejects(
    f.library.generation.saveWorkspace(project.id, doc),
    /其他窗口/,
  );
  await assert.rejects(
    f.library.generation.saveWorkspace(project.id, {
      ...saved,
      shots: [newShot('foreign', '外部素材', { x: 0, y: 0 }, foreign)],
    }),
    /不属于/,
  );
  const bad = sample();
  bad.nodes.push({
    id: 'invalid-reference',
    type: 'asset',
    assetId: foreign,
    position: { x: 10, y: 10 },
  });
  await assert.rejects(
    f.library.generation.saveWorkspace(project.id, { ...saved, shots: [bad] }),
    /不属于/,
  );
  assert.deepEqual(await f.library.generation.readWorkspace(project.id), saved);
  assert.equal(
    (await f.library.projects.open(project.id)).canvas.cards.length,
    0,
  );
  const target = join(f.base, 'moved');
  await mkdir(target);
  const migration = await f.library.migration.prepare(target);
  await f.library.migration.start(migration.token);
  await f.library.migration.idle();
  assert.equal(f.library.state().migration?.phase, 'completed');
  assert.deepEqual(await f.library.generation.readWorkspace(project.id), saved);
});

test('merged groups and detached materials survive SQLite reopen with their content and parameters', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const { project } = await f.library.projects.create('拆出与合并');
  let shot = groupMaterials(sample(), ['one', 'two'], 'first');
  shot = groupMaterials(shot, ['three'], 'second');
  const group = shot.groups[0];
  assert.ok(group);
  group.parameters.duration = 12;
  let saved = await f.library.generation.saveWorkspace(project.id, {
    ...emptyWorkspace(),
    shots: [shot],
  });
  shot = groupMaterials(shot, ['first', 'second'], 'merged', 'first');
  saved = await f.library.generation.saveWorkspace(project.id, {
    ...saved,
    shots: [shot],
  });
  shot = detachMaterial(shot, 'two');
  saved = await f.library.generation.saveWorkspace(project.id, {
    ...saved,
    shots: [shot],
  });
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
    assert.equal(saved.shots[0]?.groups[0]?.parameters.duration, 12);
    assert.equal(
      saved.shots[0]?.nodes.find((node) => node.id === 'two')?.groupId,
      undefined,
    );
  } finally {
    await reopened.close();
  }
});

test('workspace saving waits for migration and accepts durable staged references when released', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const { project } = await f.library.projects.create('迁移中的镜头');
  await f.library.gate.block();
  const assetId = await reference(f.library, project.id, 'staged');
  const shot = newShot('shot', '镜头', { x: 0, y: 0 });
  shot.nodes.push({
    id: 'reference',
    type: 'asset',
    assetId,
    position: { x: 80, y: 100 },
  });
  const doc = { ...emptyWorkspace(), shots: [shot] };
  await assert.rejects(
    f.library.generation.saveWorkspace(project.id, doc),
    /迁移/,
  );
  f.library.gate.release();
  const saved = await f.library.generation.saveWorkspace(project.id, doc);
  f.library.saves.kick();
  await f.library.saves.idle();
  assert.deepEqual(await f.library.generation.readWorkspace(project.id), saved);
  assert.equal(f.library.store.job(assetId).status, 'saved');
});
