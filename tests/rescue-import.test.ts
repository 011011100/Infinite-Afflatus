import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { truncateSync, writeFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { ProjectEditDraftService } from '../src/main/drafts/project-edit-draft-service';
import {
  RescueImportService,
  type RescueProjectAccess,
} from '../src/main/drafts/rescue-import-service';
import {
  MAX_RESCUE_SOURCE_BYTES,
  readRescueSource,
} from '../src/main/drafts/rescue-source';
import { WorkspaceDraftService } from '../src/main/drafts/workspace-draft-service';
import { GenerationService } from '../src/main/generation/generation-service';
import { recordAsset } from '../src/main/projects/project-database';
import { ProjectService } from '../src/main/projects/project-service';
import { AppStore } from '../src/main/storage/app-store';
import { safeFile } from '../src/main/storage/files';
import { WriteGate } from '../src/main/storage/write-gate';
import { emptyWorkspace, newShot } from '../src/shared/generation/workspace';
import type { Asset } from '../src/shared/models';
import type {
  NameEditDraftInput,
  TrimEditDraftInput,
} from '../src/shared/project-edit-draft';
import type { WorkspaceDraftInput } from '../src/shared/workspace-draft';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-rescue-')),
  );
  const app = join(base, 'app');
  const root = join(base, 'projects');
  await mkdir(app);
  await mkdir(root);
  const store = new AppStore(join(app, 'app.sqlite'), root);
  const gate = new WriteGate();
  const projects = new ProjectService(store, gate);
  const project = (await projects.create('原项目')).project;
  const database = await projects.databasePath(project.id);
  const id = randomUUID();
  const bytes = Buffer.from('synthetic source; immutable during import');
  const asset: Asset = {
    id,
    name: '原视频.mp4',
    relativePath: `assets/videos/${id}.mp4`,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    kind: 'video',
  };
  const media = join(root, project.folder, asset.relativePath);
  await writeFile(media, bytes);
  store.putProject(recordAsset(database, 'fixture:video', asset, project));
  const generation = new GenerationService(projects, store, gate);
  const drafts = new WorkspaceDraftService(app);
  const edits = new ProjectEditDraftService(app);
  let blocked = false;
  const access: RescueProjectAccess = {
    summary: (id) => projects.summary(id),
    read: (id) => projects.open(id),
    readWorkspace: (id) => generation.readWorkspace(id),
    databasePath: (id) => projects.databasePath(id),
    resolveAsset: (id, item) =>
      safeFile(
        store.root,
        `${projects.summary(id).folder}/${item.relativePath}`,
      ),
    assertAvailable: () => {
      if (blocked || gate.isBlocked) throw new Error('正在迁移');
    },
    run: (operation) => gate.run(operation),
  };
  const instances: RescueImportService[] = [];
  const fresh = () => {
    const service = new RescueImportService(drafts, edits, access);
    instances.push(service);
    return service;
  };
  const service = fresh();
  const name = (target = '  名称 B  '): NameEditDraftInput => ({
    kind: 'name',
    sessionId: 'active-name',
    seq: 8,
    baseline: project.name,
    target,
  });
  const card = (await projects.open(project.id)).canvas.cards[0];
  assert.ok(card);
  const trim = (): TrimEditDraftInput => ({
    kind: 'trim',
    sessionId: 'active-trim',
    seq: 9,
    baseline: structuredClone(card),
    target: {
      ...structuredClone(card),
      trims: { [id]: { start: 0.5, end: 3 } },
    },
    assets: [asset],
  });
  const workspace = (): WorkspaceDraftInput => {
    const baseline = emptyWorkspace();
    const shot = newShot(randomUUID(), '原镜头', { x: 0, y: 0 }, id);
    shot.nodes.push({
      id: 'text-node',
      type: 'text',
      text: '保留文本 🎬',
      position: { x: 5, y: 6 },
    });
    return {
      sessionId: 'active-workspace',
      seq: 7,
      baseline,
      workspace: { ...structuredClone(baseline), shots: [shot] },
    };
  };
  let serial = 0;
  const exportInput = async (
    input: WorkspaceDraftInput | NameEditDraftInput | TrimEditDraftInput,
  ) => {
    const source = join(
      base,
      `${++serial}.${'kind' in input ? 'afflatus-edit-draft' : 'afflatus-draft'}.json`,
    );
    if ('kind' in input)
      await edits.export(project, { snapshot: input }, source);
    else await drafts.export(project, { snapshot: input }, source);
    return source;
  };
  t.after(async () => {
    for (const current of instances) await current.close();
    await drafts.close();
    await edits.close();
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  return {
    base,
    app,
    root,
    project,
    database,
    media,
    asset,
    store,
    gate,
    projects,
    generation,
    drafts,
    edits,
    access,
    service,
    fresh,
    name,
    trim,
    workspace,
    exportInput,
    block: () => {
      blocked = true;
    },
  };
}

test('workspace import preserves source, exact business evidence and active stream; only explicit recovery writes project', async (t) => {
  const f = await fixture(t);
  const input = f.workspace();
  await f.drafts.protect(f.project, input);
  const activeFile = join(
    f.app,
    'workspace-drafts',
    `${f.project.id}.${input.sessionId}.json`,
  );
  const active = await readFile(activeFile);
  const source = await f.exportInput(input);
  const sourceBytes = await readFile(source);
  const database = await readFile(f.database);
  const media = await readFile(f.media);
  const jobs = f.store.jobs();
  const preview = await f.service.prepare(source, 1);
  assert.equal(preview.kind, 'workspace');
  assert.equal(preview.shotCount, 1);
  assert.equal(preview.referenceCount, 1);
  assert.equal(preview.state, 'matching');
  const result = await f.service.confirm(preview.token, 1);
  assert.match(result.key.sessionId, /^rescue-/);
  assert.equal(result.key.seq, 1);
  assert.equal(result.duplicate, false);
  const added = await f.drafts.get(f.project.id, result.key);
  const exported = JSON.parse(sourceBytes.toString()).draft;
  assert.deepEqual(added, {
    ...exported,
    sessionId: result.key.sessionId,
    seq: 1,
    saved: false,
  });
  assert.deepEqual(await readFile(activeFile), active);
  assert.deepEqual(await readFile(f.database), database);
  assert.deepEqual(f.store.jobs(), jobs);
  assert.deepEqual(await readFile(source), sourceBytes);
  await f.drafts.recover(
    f.project,
    result.key,
    () => f.generation.readWorkspace(f.project.id),
    (baseline, workspace) =>
      f.generation.saveWorkspace(f.project.id, workspace, baseline),
  );
  assert.deepEqual(await f.generation.readWorkspace(f.project.id), {
    ...input.workspace,
    revision: 1,
  });
  assert.deepEqual(await readFile(source), sourceBytes);
  assert.deepEqual(await readFile(f.media), media);
  assert.deepEqual(await readFile(activeFile), active);
});

test('name and trim imports preserve A receipt evidence, raw names and ordered source records', async (t) => {
  const f = await fixture(t);
  const name = { ...f.name('   '), lastSubmitted: '名称 A' };
  await f.projects.update(f.project.id, { name: '名称 A' });
  const source = await f.exportInput(name);
  const preview = await f.service.prepare(source, 1);
  assert.equal(preview.state, 'matching-submission');
  assert.equal(preview.nameTarget, '   ');
  assert.equal(preview.nameBaseline, '原项目');
  const result = await f.service.confirm(preview.token, 1);
  const saved = await f.edits.get(f.project.id, result.key);
  assert.equal(saved.kind, 'name');
  if (saved.kind !== 'name') throw new Error('Wrong kind');
  assert.equal(saved.target, '   ');
  assert.equal(saved.lastSubmitted, '名称 A');
  assert.equal((await f.projects.open(f.project.id)).project.name, '名称 A');
  const trim = f.trim();
  trim.lastSubmitted = {
    ...structuredClone(trim.baseline),
    trims: { [f.asset.id]: { start: 0.2, end: 4 } },
  };
  await f.projects.restoreProjectEdit(f.project.id, {
    ...trim,
    target: trim.lastSubmitted,
  });
  const trimSource = await f.exportInput(trim);
  const trimPreview = await f.service.prepare(trimSource, 1);
  assert.equal(trimPreview.state, 'matching-submission');
  const imported = await f.service.confirm(trimPreview.token, 1);
  const record = await f.edits.get(f.project.id, imported.key);
  assert.deepEqual(record, {
    ...JSON.parse(await readFile(trimSource, 'utf8')).draft,
    ...imported.key,
  });
  const restored = await f.edits.recover(
    f.project,
    imported.key,
    (draft, verify) =>
      f.projects.restoreProjectEdit(f.project.id, draft, verify),
  );
  assert.deepEqual(
    restored.canvas.cards.find((card) => card.id === trim.target.id),
    trim.target,
  );
});

test('workspace A committed B pending preserves original revisions and normalizes only during recovery', async (t) => {
  const f = await fixture(t);
  const input = f.workspace();
  const a = structuredClone(input.workspace);
  const committed = await f.generation.saveWorkspace(f.project.id, a);
  input.lastSubmitted = committed;
  const shot = input.workspace.shots[0];
  assert.ok(shot);
  shot.name = 'B';
  const source = await f.exportInput(input);
  const preview = await f.service.prepare(source, 3);
  assert.equal(preview.state, 'matching-submission');
  const result = await f.service.confirm(preview.token, 3);
  const record = await f.drafts.get(f.project.id, result.key);
  assert.equal(record.baseline.revision, 0);
  assert.equal(record.workspace.revision, 0);
  assert.deepEqual(record.lastSubmitted, committed);
  const restored = await f.drafts.recover(
    f.project,
    result.key,
    () => f.generation.readWorkspace(f.project.id),
    (baseline, workspace) =>
      f.generation.saveWorkspace(f.project.id, workspace, baseline),
  );
  assert.deepEqual(restored, { ...input.workspace, revision: 2 });
});

test('concurrent/repeated confirmation and equivalent separate files dedupe across service restarts', async (t) => {
  const f = await fixture(t);
  const source = await f.exportInput(f.name());
  const preview = await f.service.prepare(source, 1);
  const results = await Promise.all([
    f.service.confirm(preview.token, 1),
    f.service.confirm(preview.token, 1),
  ]);
  assert.deepEqual(results[0], results[1]);
  f.service.clear(1);
  assert.deepEqual(await f.service.confirm(preview.token, 1), results[0]);
  const secondSource = await f.exportInput({
    ...f.name(),
    sessionId: 'foreign-session',
    seq: 99,
  });
  const fresh = f.fresh();
  const second = await fresh.prepare(secondSource, 2);
  const again = await fresh.confirm(second.token, 2);
  assert.deepEqual(again.key, results[0]?.key);
  assert.equal(again.duplicate, true);
  assert.equal((await f.edits.list(f.project.id)).drafts.length, 1);
});

test('conflict is visible and may add a copy, but existing restore CAS still refuses overwrite', async (t) => {
  const f = await fixture(t);
  const source = await f.exportInput(f.name());
  await f.projects.update(f.project.id, { name: '另一次修改' });
  const preview = await f.service.prepare(source, 1);
  assert.equal(preview.state, 'conflict');
  const before = await readFile(f.database);
  const result = await f.service.confirm(preview.token, 1);
  await assert.rejects(
    f.edits.recover(f.project, result.key, (draft, verify) =>
      f.projects.restoreProjectEdit(f.project.id, draft, verify),
    ),
    /基线不同/,
  );
  assert.deepEqual(await readFile(f.database), before);
  assert.equal((await f.edits.list(f.project.id)).drafts.length, 1);
});

test('unknown project, wrong folder, missing and staging-only references never become imports', async (t) => {
  const f = await fixture(t);
  for (const change of [
    'project',
    'folder',
    'staging',
    'baseline',
    'submitted',
    'missing',
  ] as const) {
    const input = f.workspace();
    const source = await f.exportInput(input);
    const envelope = JSON.parse(await readFile(source, 'utf8'));
    if (change === 'project') envelope.draft.project.id = randomUUID();
    if (change === 'folder') envelope.draft.project.folder = randomUUID();
    if (change === 'staging')
      envelope.draft.workspace.shots[0].sourceAssetId = randomUUID();
    if (change === 'baseline')
      envelope.draft.baseline.shots = [
        { ...envelope.draft.workspace.shots[0], sourceAssetId: randomUUID() },
      ];
    if (change === 'submitted')
      envelope.draft.lastSubmitted = {
        ...envelope.draft.workspace,
        revision: 1,
        shots: [
          { ...envelope.draft.workspace.shots[0], sourceAssetId: randomUUID() },
        ],
      };
    if (change === 'missing') await rename(f.media, `${f.media}.away`);
    await writeFile(source, JSON.stringify(envelope));
    const original = await readFile(source);
    await assert.rejects(f.service.prepare(source, 1));
    assert.deepEqual(await readFile(source), original);
    if (change === 'missing') await rename(`${f.media}.away`, f.media);
  }
  assert.equal((await f.drafts.list(f.project.id)).drafts.length, 0);
});

test('preview rejects source replacement/modification, project changes and media replacement before confirmation', async (t) => {
  const f = await fixture(t);
  for (const change of ['replace', 'modify', 'project', 'media'] as const) {
    const source = await f.exportInput(f.workspace());
    const preview = await f.service.prepare(source, 1);
    if (change === 'replace') {
      const bytes = await readFile(source);
      await rename(source, `${source}.old`);
      await writeFile(source, bytes);
    }
    if (change === 'modify')
      await writeFile(source, `${await readFile(source, 'utf8')}\n`);
    if (change === 'project')
      await f.projects.update(f.project.id, { name: '变化后的项目' });
    if (change === 'media') {
      const bytes = await readFile(f.media);
      await rename(f.media, `${f.media}.old`);
      await writeFile(f.media, bytes);
    }
    await assert.rejects(f.service.confirm(preview.token, 1), /变化/);
    assert.equal((await f.drafts.list(f.project.id)).drafts.length, 0);
  }
});

test('owner binding, expiry, migration and clear reject without consuming active draft streams', async (t) => {
  const f = await fixture(t);
  const source = await f.exportInput(f.name());
  const preview = await f.service.prepare(source, 4);
  await assert.rejects(f.service.confirm(preview.token, 5), /无效/);
  const now = t.mock.method(
    Date,
    'now',
    () => Date.parse(preview.expiresAt) + 1,
  );
  await assert.rejects(f.service.confirm(preview.token, 4), /过期/);
  now.mock.restore();
  const again = await f.service.prepare(source, 4);
  f.service.clear(4);
  await assert.rejects(f.service.confirm(again.token, 4), /无效/);
  const next = await f.service.prepare(source, 4);
  f.block();
  await assert.rejects(f.service.confirm(next.token, 4), /迁移/);
  await assert.rejects(f.service.prepare(source, 4), /迁移/);
  assert.equal((await f.edits.list(f.project.id)).drafts.length, 0);
});

test('clear invalidates an in-flight prepare and close waits for confirmed publication', async (t) => {
  const f = await fixture(t);
  const source = await f.exportInput(f.name());
  const entered = deferred();
  const release = deferred();
  const read = f.access.read;
  f.access.read = async (id) => {
    entered.resolve();
    await release.promise;
    return read(id);
  };
  const preparing = f.service.prepare(source, 1);
  await entered.promise;
  f.service.clear(1);
  release.resolve();
  await assert.rejects(preparing, /取消/);
  f.access.read = read;
  const preview = await f.service.prepare(source, 1);
  const writeEntered = deferred();
  const writeRelease = deferred();
  const write = f.edits.files.write.bind(f.edits.files);
  const fault = t.mock.method(
    f.edits.files,
    'write',
    async (...args: Parameters<typeof write>) => {
      writeEntered.resolve();
      await writeRelease.promise;
      return write(...args);
    },
  );
  const confirmation = f.service.confirm(preview.token, 1);
  await writeEntered.promise;
  f.service.clear(1);
  let closed = false;
  const closing = f.service.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  writeRelease.resolve();
  const result = await confirmation;
  await closing;
  fault.mock.restore();
  assert.equal((await f.edits.get(f.project.id, result.key)).kind, 'name');
  await assert.rejects(f.service.prepare(source, 1), /关闭/);
});

test('write failure is retryable, and publication with a lost receipt never adds a duplicate', async (t) => {
  const f = await fixture(t);
  const source = await f.exportInput(f.name());
  const original = await readFile(source);
  const preview = await f.service.prepare(source, 1);
  const fail = t.mock.method(f.edits.files, 'write', async () => {
    throw new Error('disk full');
  });
  await assert.rejects(f.service.confirm(preview.token, 1), /disk full/);
  assert.equal((await f.edits.list(f.project.id)).drafts.length, 0);
  fail.mock.restore();
  const write = f.edits.files.write.bind(f.edits.files);
  const lost = t.mock.method(
    f.edits.files,
    'write',
    async (...args: Parameters<typeof write>) => {
      await write(...args);
      throw new Error('lost fsync receipt');
    },
  );
  await assert.rejects(f.service.confirm(preview.token, 1), /可能已写入/);
  assert.equal((await f.edits.list(f.project.id)).drafts.length, 1);
  lost.mock.restore();
  const result = await f.service.confirm(preview.token, 1);
  assert.equal(result.duplicate, true);
  assert.equal((await f.edits.list(f.project.id)).drafts.length, 1);
  assert.deepEqual(await readFile(source), original);
});

test('source format, compact bound and raw bound reject without following source or directory links', async (t) => {
  const f = await fixture(t);
  const source = await f.exportInput(f.name());
  const link = join(f.base, 'linked.json');
  await symlink(
    source,
    link,
    process.platform === 'win32' ? 'file' : undefined,
  );
  await assert.rejects(f.service.prepare(link, 1), /符号链接/);
  const directory = join(f.base, 'linked-directory');
  await symlink(
    f.base,
    directory,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(
    f.service.prepare(join(directory, source.slice(f.base.length + 1)), 1),
    /符号链接/,
  );
  for (const value of [
    '{',
    JSON.stringify({
      format: 'infinite-afflatus-workspace-rescue',
      version: 2,
    }),
    JSON.stringify({ format: 'other', version: 1 }),
  ]) {
    const path = join(f.base, 'bad.json');
    await writeFile(path, value);
    await assert.rejects(f.service.prepare(path, 1));
  }
  const large = join(f.base, 'large.json');
  const handle = await open(large, 'wx');
  await handle.truncate(MAX_RESCUE_SOURCE_BYTES + 1);
  await handle.close();
  await assert.rejects(f.service.prepare(large, 1), /64 MiB/);
  const compact = JSON.parse(await readFile(source, 'utf8'));
  compact.draft.padding = 'x'.repeat(16 * 1024 * 1024);
  const over = join(f.base, 'compact.json');
  await writeFile(over, JSON.stringify(compact));
  await assert.rejects(f.service.prepare(over, 1), /16 MB/);
});

test('successful receipts expire and retain only the original confirmed result until expiry', async (t) => {
  const f = await fixture(t);
  const source = await f.exportInput(f.name());
  const preview = await f.service.prepare(source, 1);
  const result = await f.service.confirm(preview.token, 1);
  await writeFile(source, 'source is unavailable after successful import');
  assert.deepEqual(await f.service.confirm(preview.token, 1), result);
  await assert.rejects(f.service.confirm(preview.token, 2), /无效/);
  const clock = t.mock.method(
    Date,
    'now',
    () => Date.parse(preview.expiresAt) + 1,
  );
  await assert.rejects(f.service.confirm(preview.token, 1), /过期/);
  clock.mock.restore();
  assert.equal((await f.edits.list(f.project.id)).drafts.length, 1);
});

test('malformed UTF-8 is refused intact; a BOM and pretty envelopes above 16 MiB remain valid', async (t) => {
  const f = await fixture(t);
  const source = await f.exportInput(f.name('unique text'));
  const original = await readFile(source);
  const index = original.indexOf(Buffer.from('unique text'));
  assert.ok(index >= 0);
  const broken = Buffer.from(original);
  broken[index] = 0xff;
  await writeFile(source, broken);
  await assert.rejects(f.service.prepare(source, 1), /内容损坏或文本编码无效/);
  assert.deepEqual(await readFile(source), broken);
  await writeFile(
    source,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]),
  );
  const bom = await f.service.prepare(source, 1);
  assert.equal(bom.nameTarget, 'unique text');
  const large = Buffer.concat([Buffer.alloc(17 * 1024 * 1024, 0x20), original]);
  await writeFile(source, large);
  const pretty = await f.service.prepare(source, 1);
  assert.equal(pretty.sourceBytes, large.length);
  await f.service.confirm(pretty.token, 1);
  assert.deepEqual(await readFile(source), large);
});

test('raw read growth is capped during intake and same-handle content mutation is refused', async (t) => {
  const f = await fixture(t);
  const source = await f.exportInput(f.name());
  const original = await readFile(source);
  let checks = 0;
  await assert.rejects(
    readRescueSource(source, () => {
      checks++;
      if (checks === 2) truncateSync(source, MAX_RESCUE_SOURCE_BYTES + 1);
    }),
    /64 MiB/,
  );
  assert.ok(checks <= MAX_RESCUE_SOURCE_BYTES / (64 * 1024) + 3);
  await writeFile(
    source,
    Buffer.concat([original, Buffer.alloc(128 * 1024, 0x20)]),
  );
  checks = 0;
  await assert.rejects(
    readRescueSource(source, () => {
      checks++;
      if (checks === 3) writeFileSync(source, original);
    }),
    /读取期间已变化/,
  );
});
