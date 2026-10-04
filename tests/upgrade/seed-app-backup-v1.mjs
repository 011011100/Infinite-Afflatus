// Every business writer comes from the fixed archived feature commit. Bytes are
// synthetic storage fixtures; these checks make no media-decoding claim.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const [source, data, writerCommit, mode] = process.argv.slice(2);
assert.ok(source && data);
assert.match(writerCommit, /^[a-f0-9]{40}$/);
assert.ok(['checkpoint', 'interrupted-publication'].includes(mode));
const load = (file) => import(pathToFileURL(join(source, file)).href);
const { Library } = await load('src/main/storage/library.ts');
const { AppBackupRecovery } = await load(
  'src/main/backups/app-backup-recovery.ts',
);
const { newShot, groupMaterials } = await load(
  'src/shared/generation/workspace.ts',
);
const app = join(data, '应用数据 中文');
const root = join(data, '用户项目 with spaces');
const library = await Library.open(app, root);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const protectedFiles = [];
const protect = async (file) => {
  const bytes = await fs.readFile(file);
  protectedFiles.push({ file, size: bytes.length, sha256: hash(bytes) });
};
const mediaBytes = Buffer.from(
  '历史 v1 主媒体，不能由索引恢复改写\n'.repeat(64),
);
const uniqueBytes = Buffer.from(
  '历史已确认但清理失败的唯一完整结果\n'.repeat(96),
);
const pendingBytes = Buffer.from('历史尚未提交的完整结果\n'.repeat(48));
const add = async (projectId, resultKey, kind, bytes, usage) => {
  const job = await library.acceptResult(
    {
      projectId,
      resultKey,
      kind,
      extension: kind === 'text' ? 'txt' : 'mp4',
      name: `${resultKey}.合成素材.${kind === 'text' ? 'txt' : 'mp4'}`,
      ...(usage ? { usage } : {}),
    },
    Readable.from(bytes),
  );
  await library.saves.idle();
  return library.store.job(job.id);
};
let state;
try {
  const primary = (await library.projects.create('历史备份原项目')).project;
  const independent = (await library.projects.create('独立项目')).project;
  const media = await add(primary.id, 'original-video', 'video', mediaBytes);
  const other = await add(
    independent.id,
    'independent-video',
    'video',
    Buffer.from('独立原媒体'),
  );
  assert.equal(media.status, 'saved');
  assert.equal(other.status, 'saved');
  const before = await library.projects.open(primary.id);
  const card = structuredClone(before.canvas.cards[0]);
  card.position = { x: -112.5, y: 333 };
  card.trims = { [media.id]: { start: 1.25, end: 6.75 } };
  await library.projects.patchCanvas(primary.id, {
    before: before.canvas.cards,
    after: [card],
  });
  const shot = newShot(
    'historical-shot',
    '镜头与参数保留',
    { x: 55, y: -20 },
    media.id,
  );
  shot.nodes.push({
    id: 'historical-text',
    type: 'text',
    text: '原镜头文字\n保留中文与 emoji 🎬',
    position: { x: 310, y: 100 },
  });
  const grouped = groupMaterials(
    shot,
    shot.nodes.map((node) => node.id),
    'historical-group',
  );
  grouped.groups[0].parameters.ratio = '9:16';
  grouped.groups[0].parameters.duration = 12;
  const workspace = await library.generation.saveWorkspace(primary.id, {
    version: 1,
    revision: 0,
    shots: [grouped],
  });
  const draft = structuredClone(workspace);
  draft.shots[0].nodes.push({
    id: 'protected-text',
    type: 'text',
    text: '仅在独立恢复副本中的未提交内容',
    position: { x: 20, y: 420 },
  });
  await library.drafts.protect(primary, {
    sessionId: 'backup-v1-workspace',
    seq: 4,
    baseline: workspace,
    workspace: draft,
  });
  await library.editDrafts.protect(primary, {
    kind: 'name',
    sessionId: 'backup-v1-name',
    seq: 6,
    baseline: primary.name,
    target: '  尚未确认的新名称  ',
  });
  const settings = library.interactions.get();
  settings.longPressSplit = false;
  library.interactions.save(settings);
  library.store.set('oldBackupOpaqueSetting', {
    keep: '未知设置只保留归档',
    count: 11,
  });
  const remove = library.staging.remove.bind(library.staging);
  library.staging.remove = async () => {
    throw Object.assign(new Error('fixture real saved cleanup failure'), {
      code: 'EACCES',
    });
  };
  const unique = await add(
    primary.id,
    'reference:unique-saved',
    'text',
    uniqueBytes,
    'reference',
  );
  library.staging.remove = remove;
  assert.equal(unique.status, 'saved');
  const project = await library.projects.open(primary.id);
  const uniqueAsset = project.assets.find((asset) => asset.id === unique.id);
  assert.ok(uniqueAsset);
  const missingMedia = join(root, primary.folder, uniqueAsset.relativePath);
  await fs.unlink(missingMedia);
  const uniqueReady = library.staging.path(unique.id);
  assert.deepEqual(await fs.readFile(uniqueReady), uniqueBytes);
  await library.gate.block();
  const pending = await library.acceptResult(
    {
      projectId: independent.id,
      resultKey: 'reference:pending-v1',
      kind: 'text',
      usage: 'reference',
      extension: 'txt',
      name: '完整未提交.txt',
    },
    Readable.from(pendingBytes),
  );
  library.gate.release();
  assert.equal(pending.status, 'ready');
  const userFile = join(app, 'staging', '用户另放说明.txt');
  await fs.writeFile(userFile, '不能当作任务清理');
  const backup = await library.backups.create();
  const projects = [
    await library.projects.open(primary.id),
    await library.projects.open(independent.id),
  ];
  const jobs = library.store.jobs();
  assert.equal(jobs.find((job) => job.id === unique.id).status, 'saved');
  assert.equal(jobs.find((job) => job.id === pending.id).status, 'ready');
  for (const snapshot of projects) {
    await protect(join(root, snapshot.project.folder, 'project.sqlite'));
    for (const asset of snapshot.assets) {
      if (asset.id === unique.id) continue;
      const file = join(root, snapshot.project.folder, asset.relativePath);
      assert.equal(hash(await fs.readFile(file)), asset.sha256);
      await protect(file);
    }
  }
  for (const file of [
    uniqueReady,
    library.staging.path(pending.id),
    userFile,
    join(app, 'workspace-drafts', `${primary.id}.backup-v1-workspace.json`),
    join(app, 'project-edit-drafts', `${primary.id}.backup-v1-name.json`),
    join(app, 'app-backups', backup.id, 'app.sqlite'),
    join(app, 'app-backups', backup.id, 'manifest.json'),
  ])
    await protect(file);
  const manifest = JSON.parse(
    await fs.readFile(
      join(app, 'app-backups', backup.id, 'manifest.json'),
      'utf8',
    ),
  );
  assert.equal(manifest.format, 'infinite-afflatus-app-index-backup');
  assert.equal(manifest.version, 1);
  state = {
    writerCommit,
    formatVersion: 1,
    mode,
    app,
    root,
    backup,
    projects,
    jobs,
    settings,
    workspace,
    protectedFiles,
    uniqueReady,
    missingMedia,
    original: [],
  };
} finally {
  await library.close();
}

for (const suffix of ['', '-wal', '-shm', '-journal']) {
  const name = `app.sqlite${suffix}`;
  const bytes = Buffer.from(
    `historical damaged original ${name}, ${mode}: preserve every byte`,
  );
  await fs.writeFile(join(app, name), bytes);
  state.original.push({ name, size: bytes.length, sha256: hash(bytes) });
}
if (mode === 'interrupted-publication') {
  const recovery = new AppBackupRecovery(app, 'historical-native-v1');
  const preview = await recovery.preview(state.backup.id);
  const link = fs.link;
  let injected = false;
  fs.link = async (...args) => {
    if (args[1] === join(app, 'app.sqlite')) {
      injected = true;
      throw Object.assign(new Error('historical publication interrupted'), {
        code: 'EIO',
      });
    }
    return link(...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      recovery.restore(preview.token),
      /historical publication interrupted/,
    );
  } finally {
    fs.link = link;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  const intentFile = join(app, 'app-backup-restore.json');
  const intentBytes = await fs.readFile(intentFile);
  const intent = JSON.parse(intentBytes);
  assert.equal(intent.format, 'infinite-afflatus-app-index-restore');
  assert.equal(intent.version, 1);
  assert.equal(intent.backupId, state.backup.id);
  state.intent = {
    file: intentFile,
    sha256: hash(intentBytes),
    retainedDirectory: intent.retained.path,
  };
  for (const original of state.original)
    assert.equal(
      hash(await fs.readFile(join(intent.retained.path, original.name))),
      original.sha256,
    );
  await assert.rejects(fs.readFile(join(app, 'app.sqlite')), {
    code: 'ENOENT',
  });
}
for (const file of state.protectedFiles)
  assert.equal(hash(await fs.readFile(file.file)), file.sha256);
await fs.writeFile(
  join(data, 'app-backup-v1-expected.json'),
  JSON.stringify(state),
);
