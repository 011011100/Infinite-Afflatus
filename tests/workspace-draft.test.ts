import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { MAX_DRAFT_STORAGE_BYTES } from '../src/main/drafts/draft-validation';
import { WorkspaceDraftService } from '../src/main/drafts/workspace-draft-service';
import { withProject } from '../src/main/projects/project-database';
import { Library } from '../src/main/storage/library';
import { emptyWorkspace, newShot } from '../src/shared/generation/workspace';
import {
  submittedWorkspace,
  type WorkspaceDraftInput,
} from '../src/shared/workspace-draft';

const project = {
  id: 'project',
  folder: 'project',
  name: '镜头保护',
  updatedAt: '',
};
const baseline = {
  ...emptyWorkspace(),
  shots: [newShot('shot', '镜头一', { x: 0, y: 0 })],
};
function input(
  text = '尚未提交的文字',
  seq = 1,
  sessionId = 'session',
): WorkspaceDraftInput {
  const workspace = structuredClone(baseline);
  const shot = workspace.shots[0];
  assert.ok(shot);
  shot.nodes.push({
    id: 'text',
    type: 'text',
    text,
    position: { x: 0, y: 0 },
  });
  return { sessionId, seq, baseline: structuredClone(baseline), workspace };
}
async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-drafts-')),
  );
  const data = join(root, 'app');
  await mkdir(data);
  const services: WorkspaceDraftService[] = [];
  const service = () => {
    const next = new WorkspaceDraftService(data);
    services.push(next);
    return next;
  };
  t.after(async () => {
    for (const current of services) await current.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    data,
    service,
    drafts: service(),
    file: join(data, 'workspace-drafts', 'project.session.json'),
  };
}

test('independent snapshots survive restart with the library database corrupt and the project volume missing', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.data, 'app.sqlite'), 'broken app database');
  const draft = input();
  await f.drafts.protect(project, draft);
  await f.drafts.close();
  const reopened = f.service();
  const found = await reopened.list(project.id);
  assert.equal(found.drafts.length, 1);
  assert.deepEqual(found.drafts[0]?.workspace, draft.workspace);
  assert.deepEqual(found.drafts[0]?.baseline, draft.baseline);
  assert.equal(
    await readFile(join(f.data, 'app.sqlite'), 'utf8'),
    'broken app database',
  );
});

test('late protect and acknowledgement cannot replace or remove a newer sequence; successful sessions do not accumulate files', async (t) => {
  const f = await fixture(t);
  const a = input('A', 1);
  const b = input('B', 2);
  await Promise.all([
    f.drafts.protect(project, a),
    f.drafts.protect(project, b),
  ]);
  assert.equal(await f.drafts.protect(project, a), 2);
  assert.equal(
    await f.drafts.acknowledge(project.id, a, submittedWorkspace(a)),
    false,
  );
  assert.deepEqual((await f.drafts.get(project.id, b)).workspace, b.workspace);
  assert.equal(
    await f.drafts.acknowledge(project.id, b, submittedWorkspace(b)),
    true,
  );
  await f.drafts.protect(project, a);
  await f.drafts.protect(project, b);
  assert.deepEqual(await readdir(f.drafts.files.directory), []);
  for (let i = 0; i < 40; i++) {
    const draft = input('日常保存', 1, `session-${i}`);
    await f.drafts.protect(project, draft);
    await f.drafts.acknowledge(project.id, draft, submittedWorkspace(draft));
  }
  assert.deepEqual(await readdir(f.drafts.files.directory), []);
});

test('an interrupted atomic write retains the previous exact snapshot and leaves no partial replacement', async (t) => {
  const f = await fixture(t);
  await f.drafts.protect(project, input('before'));
  const previous = await readFile(f.file);
  const probe = await open(join(f.root, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const fault = t.mock.method(prototype, 'sync', async () => {
    throw new Error('injected fsync failure');
  });
  await assert.rejects(
    f.drafts.protect(project, input('after', 2)),
    /fsync failure/,
  );
  fault.mock.restore();
  assert.deepEqual(await readFile(f.file), previous);
  assert.deepEqual(await readdir(f.drafts.files.directory), [
    'project.session.json',
  ]);
  await f.drafts.protect(project, input('retry', 3));
  assert.deepEqual(
    (await f.drafts.get(project.id, { sessionId: 'session', seq: 3 }))
      .workspace,
    input('retry', 3).workspace,
  );
});

test('corrupt drafts and symbolic links are preserved and reported without following them', async (t) => {
  const f = await fixture(t);
  await f.drafts.list(project.id);
  await writeFile(f.file, '{broken');
  const outside = join(f.root, 'outside.json');
  await writeFile(outside, 'keep outside bytes');
  await symlink(outside, join(f.drafts.files.directory, 'project.link.json'));
  const list = await f.drafts.list(project.id);
  assert.equal(list.issues.length, 2);
  assert.equal(list.drafts.length, 0);
  await assert.rejects(
    f.drafts.protect(project, input()),
    /JSON|position|property/i,
  );
  await assert.rejects(
    f.drafts.protect(project, input('bad', 1, 'link')),
    /无效/,
  );
  assert.equal(await readFile(f.file, 'utf8'), '{broken');
  assert.equal(await readFile(outside, 'utf8'), 'keep outside bytes');
  assert.throws(
    () => f.drafts.protect(project, input('x', 1, '../escape')),
    /标识/,
  );
});

test('replacement quota counts final bytes and oversized new content is not silently lost', async (t) => {
  const f = await fixture(t);
  await f.drafts.protect(project, input('A'));
  const size = (await readFile(f.file)).length;
  const filler = join(f.drafts.files.directory, 'retained-unrecognized-file');
  await writeFile(filler, '');
  await truncate(filler, MAX_DRAFT_STORAGE_BYTES - size);
  await f.drafts.protect(project, input('B', 2));
  const previous = await readFile(f.file);
  await assert.rejects(f.drafts.protect(project, input('larger', 3)), /空间/);
  assert.deepEqual(await readFile(f.file), previous);
});

test('lost project acknowledgement is recognized by complete content and exact next revision only', async (t) => {
  const f = await fixture(t);
  const draft = input();
  await f.drafts.protect(project, draft);
  const committed = submittedWorkspace(draft);
  const saved = await f.service().recover(
    project,
    draft,
    async () => committed,
    async () => {
      throw new Error('must not write twice');
    },
  );
  assert.deepEqual(saved, committed);
  assert.deepEqual((await f.drafts.list(project.id)).drafts, []);
  const second = input('different session', 1, 'second');
  await f.drafts.protect(project, second);
  await assert.rejects(
    f.drafts.recover(
      project,
      second,
      async () => ({ ...second.workspace, revision: 7 }),
      async () => {
        throw new Error('must not write');
      },
    ),
    /基线不同/,
  );
  assert.equal((await f.drafts.list(project.id)).drafts.length, 1);
});

test('recorded submission A lets B resume from A, including losing the recovery reply after committing B', async (t) => {
  const f = await fixture(t);
  const a = input('A');
  const b = { ...input('B', 2), lastSubmitted: submittedWorkspace(a) };
  await f.drafts.protect(project, b);
  let disk = submittedWorkspace(a);
  await assert.rejects(
    f.drafts.recover(
      project,
      b,
      async () => disk,
      async (expected, workspace) => {
        assert.deepEqual(expected, disk);
        assert.equal(workspace.revision, disk.revision);
        disk = { ...workspace, revision: workspace.revision + 1 };
        throw new Error('reply lost after COMMIT');
      },
    ),
    /reply lost/,
  );
  const reopened = f.service();
  const record = (await reopened.list(project.id)).drafts[0];
  assert.ok(record);
  assert.equal(record.seq, 3);
  assert.equal(record.baseline.revision, 1);
  const restored = await reopened.recover(
    project,
    record,
    async () => disk,
    async () => {
      throw new Error('duplicate write');
    },
  );
  assert.deepEqual(restored, { ...b.workspace, revision: 2 });
  assert.deepEqual((await reopened.list(project.id)).drafts, []);
  assert.throws(
    () =>
      f.drafts.protect(project, {
        ...input(),
        lastSubmitted: { ...a.workspace, revision: 8 },
      }),
    /在途提交/,
  );
});

test('restore rejects a same-revision replacement inside the actual database transaction; rescue remains exportable', async (t) => {
  const f = await fixture(t);
  const library = await Library.open(
    join(f.root, 'library-app'),
    join(f.root, 'projects'),
  );
  t.after(() => library.close());
  const { project: actual } = await library.projects.create('恢复事务');
  const base = await library.generation.saveWorkspace(actual.id, baseline);
  const draft = {
    ...input(),
    baseline: base,
    workspace: { ...input().workspace, revision: base.revision },
  };
  await f.drafts.protect(actual, draft);
  const file = await library.projects.databasePath(actual.id);
  let replaced: Buffer | undefined;
  await assert.rejects(
    f.drafts.recover(
      actual,
      draft,
      () => library.generation.readWorkspace(actual.id),
      async (expected, value) => {
        withProject(
          file,
          true,
          (db) => {
            db.prepare(
              "UPDATE metadata SET value = ? WHERE key = 'generation-workspace'",
            ).run(
              JSON.stringify({
                ...base,
                shots: [newShot('foreign', '外部同版本内容', { x: 0, y: 0 })],
              }),
            );
          },
          actual,
        );
        replaced = await readFile(file);
        return library.generation.saveWorkspace(actual.id, value, expected);
      },
    ),
    /内容已变化/,
  );
  assert.deepEqual(await readFile(file), replaced);
  assert.equal((await f.drafts.list(actual.id)).drafts.length, 1);
  const exported = join(f.root, 'rescue.afflatus-draft.json');
  await f.drafts.export(actual, draft, exported);
  const rescue = JSON.parse(await readFile(exported, 'utf8'));
  assert.equal(rescue.format, 'infinite-afflatus-workspace-rescue');
  assert.deepEqual(rescue.draft.workspace, draft.workspace);
  const bytes = await readFile(exported);
  await assert.rejects(f.drafts.export(actual, draft, exported), {
    code: 'EEXIST',
  });
  assert.deepEqual(await readFile(exported), bytes);
});

test('a current snapshot can be exported even if the internal recovery directory is unusable', async (t) => {
  const f = await fixture(t);
  await writeFile(f.drafts.files.directory, 'not a directory');
  await assert.rejects(f.drafts.protect(project, input()), /目录/);
  const exported = join(f.root, 'live.afflatus-draft.json');
  await f.drafts.export(project, { snapshot: input() }, exported);
  assert.deepEqual(
    JSON.parse(await readFile(exported, 'utf8')).draft.workspace,
    input().workspace,
  );
  assert.equal(
    await readFile(f.drafts.files.directory, 'utf8'),
    'not a directory',
  );
});

test('cleanup never adopts the identity of a file replaced after reading the acknowledged sequence', async (t) => {
  const f = await fixture(t);
  const draft = input();
  await f.drafts.protect(project, draft);
  const original = f.drafts.files.read.bind(f.drafts.files);
  let reads = 0;
  const replacement = Buffer.from('{unrecognized replacement, keep me');
  t.mock.method(f.drafts.files, 'read', async (name: string) => {
    const value = await original(name);
    reads++;
    if (reads === 2) await writeFile(f.file, replacement);
    return value;
  });
  await assert.rejects(
    f.drafts.acknowledge(project.id, draft, submittedWorkspace(draft)),
    /清理期间变化/,
  );
  assert.deepEqual(await readFile(f.file), replacement);
});
