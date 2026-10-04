// All business modules are loaded from the exact archived writer commit.
// AppStore + services avoid auto-running the historical ready SaveQueue job.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [source, directory, writerCommit, mode] = process.argv.slice(2);
assert.ok(source && directory);
assert.match(writerCommit, /^[a-f0-9]{40}$/);
assert.ok(
  [
    'name-input',
    'name-last-submitted',
    'trim-input',
    'trim-last-submitted',
  ].includes(mode),
);
const load = (path) => import(pathToFileURL(join(source, path)).href);
const { AppStore } = await load('src/main/storage/app-store.ts');
const { WriteGate } = await load('src/main/storage/write-gate.ts');
const { ProjectService } = await load('src/main/projects/project-service.ts');
const { ProjectEditDraftService } = await load(
  'src/main/drafts/project-edit-draft-service.ts',
);
const expected = JSON.parse(
  await readFile(join(directory, 'expected.json'), 'utf8'),
);
const [original, independent] = expected.projects;
assert.ok(original && independent && expected.workspace);
const app = join(directory, 'app');
const store = new AppStore(join(app, 'app.sqlite'), expected.root);
const projects = new ProjectService(store, new WriteGate());
const drafts = new ProjectEditDraftService(app);
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const path = (projectId, sessionId) =>
  join(app, 'project-edit-drafts', `${projectId}.${sessionId}.json`);
const metadata = (file, key) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)
      ?.value;
  } finally {
    db.close();
  }
};
try {
  assert.deepEqual(await projects.open(original.project.id), original);
  const sessionId = `historical-${mode}`;
  const submitted = mode.endsWith('last-submitted');
  let input;
  let first;
  if (mode.startsWith('name')) {
    first = {
      kind: 'name',
      sessionId,
      seq: 1,
      baseline: original.project.name,
      target: '历史名称提交 A',
    };
    input = {
      ...first,
      seq: submitted ? 2 : 1,
      target: '  尚未确认的 中文名称 B 🎬  ',
      ...(submitted ? { lastSubmitted: first.target } : {}),
    };
  } else {
    const baseline = structuredClone(original.canvas.cards[0]);
    assert.equal(baseline.assetIds.length, 3);
    const assets = baseline.assetIds.map((id) => {
      const asset = original.assets.find((item) => item.id === id);
      assert.ok(asset && asset.kind === 'video' && asset.usage === undefined);
      return structuredClone(asset);
    });
    const targetA = structuredClone(baseline);
    targetA.trims[baseline.assetIds[0]] = { start: 4, end: 11 };
    const targetB = structuredClone(targetA);
    targetB.trims[baseline.assetIds[0]] = { start: 5.125, end: 10.75 };
    targetB.trims[baseline.assetIds[1]] = { start: 2.25, end: 8.5 };
    first = {
      kind: 'trim',
      sessionId,
      seq: 1,
      baseline,
      target: targetA,
      assets,
    };
    input = {
      ...first,
      seq: submitted ? 2 : 1,
      target: targetB,
      ...(submitted ? { lastSubmitted: targetA } : {}),
    };
  }
  if (submitted) {
    await drafts.protect(original.project, first);
    // Really commit A through the historical project transaction. Deliberately
    // omit the draft acknowledgement, as if the caller lost its response.
    const savedA = await projects.restoreProjectEdit(
      original.project.id,
      first,
    );
    if (first.kind === 'name') assert.equal(savedA.project.name, first.target);
    else
      assert.deepEqual(
        savedA.canvas.cards.find((card) => card.id === first.target.id),
        first.target,
      );
  }
  assert.equal(await drafts.protect(original.project, input), input.seq);
  const found = await drafts.list(original.project.id);
  assert.deepEqual(found.issues, []);
  assert.equal(found.drafts.length, 1);
  const record = found.drafts[0];
  assert.deepEqual(record, {
    ...input,
    format: 'infinite-afflatus-project-edit-draft',
    version: 1,
    project: {
      id: original.project.id,
      folder: original.project.folder,
      name: original.project.name,
    },
    updatedAt: record.updatedAt,
  });
  assert.ok(Number.isFinite(Date.parse(record.updatedAt)));
  const file = path(original.project.id, sessionId);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), record);

  // Unknown-version and broken JSON are explicit fault fixtures derived from
  // records actually written by the old public API, never a current-code writer.
  const retained = [];
  for (const broken of ['future', 'broken']) {
    await drafts.protect(original.project, {
      kind: 'name',
      sessionId: broken,
      seq: 1,
      baseline: original.project.name,
      target: '保留负例输入',
    });
    const file = path(original.project.id, broken);
    if (broken === 'future') {
      const value = JSON.parse(await readFile(file, 'utf8'));
      value.version = 999;
      await writeFile(file, JSON.stringify(value));
    } else await writeFile(file, '{deliberately broken JSON');
    retained.push({ file, sha256: await hash(file) });
  }
  const independentInput = {
    kind: 'name',
    sessionId: 'independent-name',
    seq: 7,
    baseline: independent.project.name,
    target: '独立项目的未保存名称',
  };
  await drafts.protect(independent.project, independentInput);
  const independentRecord = (await drafts.list(independent.project.id))
    .drafts[0];
  assert.ok(independentRecord);
  for (const file of [
    path(independent.project.id, independentInput.sessionId),
    join(expected.root, independent.project.folder, 'project.sqlite'),
    join(expected.root, expected.pendingProject.folder, 'project.sqlite'),
    join(app, 'staging', `${expected.queued.id}.ready`),
  ])
    retained.push({ file, sha256: await hash(file) });
  const userFile = join(app, 'project-edit-drafts', '用户保留说明.txt');
  await writeFile(userFile, '不能把未识别文件当作恢复副本清理');
  retained.push({ file: userFile, sha256: await hash(userFile) });
  assert.deepEqual(store.jobs(), expected.jobs);
  const db = new DatabaseSync(join(app, 'app.sqlite'), { readOnly: true });
  let settings;
  try {
    settings = db
      .prepare('SELECT key, value FROM settings ORDER BY key')
      .all()
      .map((row) => ({ key: String(row.key), value: String(row.value) }));
  } finally {
    db.close();
  }
  const projectFile = join(
    expected.root,
    original.project.folder,
    'project.sqlite',
  );
  await writeFile(
    join(directory, 'project-edit-draft-expected.json'),
    JSON.stringify(
      {
        writerCommit,
        mode,
        formatVersion: 1,
        input,
        record,
        disk: await projects.open(original.project.id),
        file,
        fileSha256: await hash(file),
        retained,
        independentRecord,
        settings,
        workspaceRaw: metadata(projectFile, 'generation-workspace'),
      },
      null,
      2,
    ),
  );
} finally {
  await drafts.close();
  store.close();
}
