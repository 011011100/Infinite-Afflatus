// Only the archived writer supplies business code. The export is not assembled
// with today's codec: protect, commit and export all run through old public APIs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [source, directory, writerCommit, mode] = process.argv.slice(2);
assert.ok(source && directory);
assert.match(writerCommit, /^[a-f0-9]{40}$/);
assert.ok(
  [
    'workspace-input',
    'workspace-last-submitted',
    'workspace-submitted',
    'name-last-submitted',
    'name-blank',
    'trim-input',
    'trim-last-submitted',
    'trim-conflict',
  ].includes(mode),
);
const load = (path) => import(pathToFileURL(join(source, path)).href);
const { AppStore } = await load('src/main/storage/app-store.ts');
const { WriteGate } = await load('src/main/storage/write-gate.ts');
const { ProjectService } = await load('src/main/projects/project-service.ts');
const { GenerationService } = await load(
  'src/main/generation/generation-service.ts',
);
const { WorkspaceDraftService } = await load(
  'src/main/drafts/workspace-draft-service.ts',
);
const expected = JSON.parse(
  await readFile(join(directory, 'expected.json'), 'utf8'),
);
const [original, independent] = expected.projects;
assert.ok(original && independent && expected.workspace);
const app = join(directory, 'app');
const store = new AppStore(join(app, 'app.sqlite'), expected.root);
const gate = new WriteGate();
const projects = new ProjectService(store, gate);
const generation = new GenerationService(projects, store, gate);
const workspaces = new WorkspaceDraftService(app);
const workspaceKind = mode.startsWith('workspace');
const edits = workspaceKind
  ? null
  : new (
      await load('src/main/drafts/project-edit-draft-service.ts')
    ).ProjectEditDraftService(app);
const service = workspaceKind ? workspaces : edits;
const sessionId = `historical-export-${mode}`;
const submitted = mode.endsWith('last-submitted');
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
try {
  let input;
  if (workspaceKind) {
    const baseline = structuredClone(expected.workspace);
    const first = structuredClone(baseline);
    first.shots[0].nodes.find((node) => node.id === 'text-two').text +=
      '\n历史已提交 A 📨';
    let next = structuredClone(first);
    let lastSubmitted;
    if (submitted) {
      lastSubmitted = {
        ...structuredClone(first),
        revision: baseline.revision + 1,
      };
      await workspaces.protect(original.project, {
        sessionId,
        seq: 1,
        baseline,
        workspace: first,
        lastSubmitted,
      });
      assert.deepEqual(
        await generation.saveWorkspace(original.project.id, first),
        lastSubmitted,
      );
      next = structuredClone(lastSubmitted);
    }
    // An uncertain A response does not advance the editor's confirmed revision.
    // B keeps the original baseline revision and carries A as exact evidence.
    next.revision = baseline.revision;
    const shot = next.shots[0];
    shot.nodes.find((node) => node.id === 'text-two').text +=
      '\n导出后待恢复 B，保留中文和换行。';
    shot.nodes.find((node) => node.id === 'reference-2').textOverride =
      '救援编辑内容，源文本必须不变';
    shot.groups.find((group) => group.id === 'group-one').parameters = {
      model: 'seedance-2.0',
      ratio: '1:1',
      resolution: '1080p',
      duration: 8,
      generateAudio: true,
    };
    shot.groups.find(
      (group) => group.id === 'image-text-group',
    ).parameters.resolution = '4K';
    [shot.nodes[0], shot.nodes[1]] = [shot.nodes[1], shot.nodes[0]];
    shot.viewport = { x: -122.5, y: 67, zoom: 0.75 };
    shot.labels[0].name = '救援标签';
    input = {
      sessionId,
      seq: submitted ? 2 : 1,
      baseline,
      workspace: next,
      ...(lastSubmitted ? { lastSubmitted } : {}),
    };
    if (mode === 'workspace-submitted') {
      const saved = await generation.saveWorkspace(original.project.id, next);
      assert.deepEqual(saved, { ...next, revision: baseline.revision + 1 });
    }
  } else if (mode.startsWith('name')) {
    const first = {
      kind: 'name',
      sessionId,
      seq: 1,
      baseline: original.project.name,
      target: '历史名称 A 已确认',
    };
    if (submitted) {
      await edits.protect(original.project, first);
      assert.equal(
        (await projects.restoreProjectEdit(original.project.id, first)).project
          .name,
        first.target,
      );
    }
    input = {
      ...first,
      seq: submitted ? 2 : 1,
      target: mode === 'name-blank' ? '   ' : '  导入救援后的名称 B 🎬  ',
      ...(submitted ? { lastSubmitted: first.target } : {}),
    };
  } else {
    const baseline = structuredClone(original.canvas.cards[0]);
    const assets = baseline.assetIds.map((id) =>
      structuredClone(original.assets.find((asset) => asset.id === id)),
    );
    assert.equal(assets.length, 3);
    assert.ok(assets.every((asset) => asset?.kind === 'video'));
    const firstTarget = structuredClone(baseline);
    firstTarget.trims[baseline.assetIds[0]] = { start: 4, end: 11 };
    const first = {
      kind: 'trim',
      sessionId,
      seq: 1,
      baseline,
      target: firstTarget,
      assets,
    };
    if (submitted) {
      await edits.protect(original.project, first);
      const saved = await projects.restoreProjectEdit(
        original.project.id,
        first,
      );
      assert.deepEqual(saved.canvas.cards[0], firstTarget);
    }
    const target = structuredClone(firstTarget);
    target.trims[baseline.assetIds[0]] = { start: 5.125, end: 10.75 };
    target.trims[baseline.assetIds[1]] = { start: 2.25, end: 8.5 };
    input = {
      ...first,
      seq: submitted ? 2 : 1,
      target,
      ...(submitted ? { lastSubmitted: firstTarget } : {}),
    };
    if (mode === 'trim-conflict') {
      const other = structuredClone(baseline);
      other.trims[baseline.assetIds[0]] = { start: 6, end: 9 };
      await projects.patchCanvas(original.project.id, {
        before: original.canvas.cards,
        after: [other],
      });
    }
  }
  assert.equal(await service.protect(original.project, input), input.seq);
  const record = (await service.list(original.project.id)).drafts[0];
  assert.ok(record);
  for (const [key, value] of Object.entries(input))
    assert.deepEqual(record[key], value, `Old writer changed authored ${key}`);
  const external = join(directory, '用户救援文件 with spaces');
  await mkdir(external);
  const exportPath = join(
    external,
    workspaceKind
      ? '镜头.afflatus-draft.json'
      : '编辑.afflatus-edit-draft.json',
  );
  assert.equal(
    await service.export(
      original.project,
      { sessionId, seq: input.seq },
      exportPath,
    ),
    exportPath,
  );
  const exported = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.equal(
    exported.format,
    workspaceKind
      ? 'infinite-afflatus-workspace-rescue'
      : 'infinite-afflatus-project-edit-rescue',
  );
  assert.equal(exported.version, 1);
  assert.deepEqual(exported.draft, record);

  // Retain both same-project and other-project streams. An import gets its own
  // new session and must never replace or acknowledge the exporting stream.
  for (const project of [original.project, independent.project]) {
    const baseline = await generation.readWorkspace(project.id);
    await workspaces.protect(project, {
      sessionId: 'unrelated-workspace',
      seq: 3,
      baseline,
      workspace: baseline,
    });
  }
  const retained = [];
  for (const file of [
    exportPath,
    join(
      app,
      workspaceKind ? 'workspace-drafts' : 'project-edit-drafts',
      `${original.project.id}.${sessionId}.json`,
    ),
    join(
      app,
      'workspace-drafts',
      `${original.project.id}.unrelated-workspace.json`,
    ),
    join(
      app,
      'workspace-drafts',
      `${independent.project.id}.unrelated-workspace.json`,
    ),
    join(expected.root, independent.project.folder, 'project.sqlite'),
    join(expected.root, expected.pendingProject.folder, 'project.sqlite'),
    join(app, 'staging', `${expected.queued.id}.ready`),
  ])
    retained.push({ file, sha256: await hash(file) });
  assert.deepEqual(store.jobs(), expected.jobs);
  const db = new DatabaseSync(join(app, 'app.sqlite'), { readOnly: true });
  let settings;
  try {
    settings = db
      .prepare('SELECT key,value FROM settings ORDER BY key')
      .all()
      .map((row) => ({ key: String(row.key), value: String(row.value) }));
  } finally {
    db.close();
  }
  await writeFile(
    join(directory, 'rescue-expected.json'),
    JSON.stringify(
      {
        writerCommit,
        mode,
        record,
        exportPath,
        retained,
        settings,
        disk: await projects.open(original.project.id),
        workspace: await generation.readWorkspace(original.project.id),
        workspaceDrafts: await workspaces.list(original.project.id),
        editDrafts: edits
          ? await edits.list(original.project.id)
          : { drafts: [], issues: [] },
        independentDrafts: await workspaces.list(independent.project.id),
      },
      null,
      2,
    ),
  );
} finally {
  await workspaces.close();
  await edits?.close();
  store.close();
}
