import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { GenerationService } from '../src/main/generation/generation-service';
import { ProjectService } from '../src/main/projects/project-service';
import { AppStore } from '../src/main/storage/app-store';
import { WriteGate } from '../src/main/storage/write-gate';
import { saveWorkspaceSubmission } from '../src/renderer/src/features/generation/workspace-save-submission';
import {
  emptyWorkspace,
  type GenerationWorkspace,
  newShot,
} from '../src/shared/generation/workspace';

function submission(): GenerationWorkspace {
  const shot = newShot('shot', '待提交的镜头', { x: 140, y: 270 });
  shot.nodes = [
    {
      id: 'text',
      type: 'text',
      text: '正文应与提交时完全一致',
      position: { x: 40, y: 80 },
    },
  ];
  return { ...emptyWorkspace(), shots: [shot] };
}

async function fixture(t: TestContext) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-workspace-receipt-')),
  );
  const root = join(base, 'projects');
  await mkdir(root);
  const store = new AppStore(join(base, 'app.sqlite'), root);
  const gate = new WriteGate();
  t.after(async () => {
    await gate.idle();
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  const projects = new ProjectService(store, gate);
  const generation = new GenerationService(projects, store, gate);
  const { project } = await projects.create('提交回执验证');
  return { project, projects, generation };
}

test('a normal workspace save returns the original result without a recovery read', async () => {
  const submitted = submission();
  const saved = { ...structuredClone(submitted), revision: 1 };
  let writes = 0;
  let reads = 0;
  const result = await saveWorkspaceSubmission(
    {
      saveGenerationWorkspace: async (projectId, input) => {
        writes++;
        assert.equal(projectId, 'project');
        assert.equal(input, submitted);
        return saved;
      },
      getGenerationWorkspace: async () => {
        reads++;
        throw new Error('正常保存不应回读');
      },
    },
    'project',
    submitted,
  );
  assert.equal(result, saved);
  assert.equal(writes, 1);
  assert.equal(reads, 0);
  assert.equal(submitted.revision, 0);
});

test('a real SQLite commit with a lost receipt is confirmed by one exact read and never rewritten', async (t) => {
  const f = await fixture(t);
  const { project: other } = await f.projects.create('不相关项目');
  const otherFile = await f.projects.databasePath(other.id);
  const otherBefore = await readFile(otherFile);
  const submitted = submission();
  const before = structuredClone(submitted);
  const lost = new Error('真实事务已经提交，回执丢失');
  let writes = 0;
  let reads = 0;
  const recovered = await saveWorkspaceSubmission(
    {
      saveGenerationWorkspace: async (id, input) => {
        writes++;
        await f.generation.saveWorkspace(id, input);
        throw lost;
      },
      getGenerationWorkspace: async (id) => {
        reads++;
        return f.generation.readWorkspace(id);
      },
    },
    f.project.id,
    submitted,
  );
  assert.deepEqual(recovered, { ...before, revision: 1 });
  assert.deepEqual(await f.generation.readWorkspace(f.project.id), recovered);
  assert.deepEqual(submitted, before);
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.deepEqual(await readFile(otherFile), otherBefore);
});

test('a SQLite result at the expected revision with different content is not adopted', async (t) => {
  const f = await fixture(t);
  const submitted = submission();
  const before = structuredClone(submitted);
  const conflict = structuredClone(submitted);
  const text = conflict.shots[0]?.nodes[0];
  assert.ok(text?.type === 'text');
  text.text = '另一个写入的正文';
  const originalError = new Error('保存回执失败');
  let writes = 0;
  await assert.rejects(
    saveWorkspaceSubmission(
      {
        saveGenerationWorkspace: async (id) => {
          writes++;
          await f.generation.saveWorkspace(id, conflict);
          throw originalError;
        },
        getGenerationWorkspace: (id) => f.generation.readWorkspace(id),
      },
      f.project.id,
      submitted,
    ),
    (error) => error === originalError,
  );
  assert.equal(writes, 1);
  assert.deepEqual(await f.generation.readWorkspace(f.project.id), {
    ...conflict,
    revision: 1,
  });
  assert.deepEqual(submitted, before);
});

test('matching content more than one revision ahead is not attributed to the failed submission', async (t) => {
  const f = await fixture(t);
  const submitted = submission();
  const before = structuredClone(submitted);
  const originalError = new Error('没有可核实的单次提交回执');
  let requests = 0;
  await assert.rejects(
    saveWorkspaceSubmission(
      {
        saveGenerationWorkspace: async (id, input) => {
          requests++;
          const saved = await f.generation.saveWorkspace(id, input);
          await f.generation.saveWorkspace(id, saved);
          throw originalError;
        },
        getGenerationWorkspace: (id) => f.generation.readWorkspace(id),
      },
      f.project.id,
      submitted,
    ),
    (error) => error === originalError,
  );
  assert.equal(requests, 1);
  assert.deepEqual(await f.generation.readWorkspace(f.project.id), {
    ...before,
    revision: 2,
  });
  assert.deepEqual(submitted, before);
});

test('a save that never committed keeps the original failure and current SQLite content', async (t) => {
  const f = await fixture(t);
  const submitted = submission();
  const originalError = new Error('尚未开始事务就失败');
  const before = await f.generation.readWorkspace(f.project.id);
  await assert.rejects(
    saveWorkspaceSubmission(
      {
        saveGenerationWorkspace: async () => {
          throw originalError;
        },
        getGenerationWorkspace: (id) => f.generation.readWorkspace(id),
      },
      f.project.id,
      submitted,
    ),
    (error) => error === originalError,
  );
  assert.deepEqual(await f.generation.readWorkspace(f.project.id), before);
  assert.equal(submitted.revision, 0);
});

test('a failed recovery read preserves the original save error instead of replacing it', async () => {
  const submitted = submission();
  const before = structuredClone(submitted);
  const originalError = new Error('写入失败，请保留此错误');
  const readError = new Error('只读检查也失败');
  let writes = 0;
  let reads = 0;
  await assert.rejects(
    saveWorkspaceSubmission(
      {
        saveGenerationWorkspace: async () => {
          writes++;
          throw originalError;
        },
        getGenerationWorkspace: async () => {
          reads++;
          throw readError;
        },
      },
      'project',
      submitted,
    ),
    (error) => error === originalError,
  );
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.deepEqual(submitted, before);
});
