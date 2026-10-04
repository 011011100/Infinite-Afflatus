// All business writes use the immutable archived Library. Synthetic text/video
// bytes exercise storage, not media decoding. No current writer creates history.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, data, writerCommit] = process.argv.slice(2);
assert.ok(source && data);
assert.equal(writerCommit, '0550d2cbe736daf7443e8570a18c57a6aec1b4bd');
const load = (file) => import(pathToFileURL(join(source, file)).href);
const { Library } = await load('src/main/storage/library.ts');
const { newShot, groupMaterials } = await load(
  'src/shared/generation/workspace.ts',
);
const app = join(data, '应用资料 with spaces');
const root = join(data, '旧项目 中文');
const sources = join(data, '外部原素材');
await mkdir(sources);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = [];
for (const [name, text] of [
  ['主视频.mp4', 'Synthetic storage video bytes, no decoding claim 🎬\n'],
  ['唯一保存结果.txt', '已保存且只在清理最后一步失败的完整参考\n'],
  ['独立项目.txt', '独立项目不可变化\n'],
  ['排队参考.txt', '尚未登记的引用必须由原保存队列正常完成\n'],
]) {
  const file = join(sources, name);
  await writeFile(file, text.repeat(37), { flag: 'wx' });
  files.push(file);
}
const [videoSource, retainedSource, independentSource, queuedSource] = files;
const library = await Library.open(app, root);
let state;
try {
  const primary = (await library.projects.create('历史原项目')).project;
  const independent = (await library.projects.create('独立项目保留')).project;
  const pending = (await library.projects.create('既有排队镜头')).project;
  const receive = async (projectId, resultKey, file, kind = 'text') => {
    const accepted = await library.acceptResult(
      {
        projectId,
        resultKey,
        name: basename(file),
        kind,
        usage: 'reference',
        extension: kind === 'video' ? 'mp4' : 'txt',
      },
      createReadStream(file),
    );
    await library.saves.idle();
    const job = library.store.job(accepted.id);
    assert.equal(job.sha256, hash(await readFile(file)));
    return job;
  };
  const video = await receive(
    primary.id,
    'reference:original-video',
    videoSource,
    'video',
  );
  const other = await receive(
    independent.id,
    'reference:independent',
    independentSource,
  );
  assert.equal(video.status, 'saved');
  assert.equal(other.status, 'saved');
  const remove = library.staging.remove.bind(library.staging);
  let cleanupFailures = 0;
  library.staging.remove = async (job, ...args) => {
    if (job.resultKey === 'reference:saved-cleanup-failure') {
      cleanupFailures++;
      throw Object.assign(new Error('Historical post-commit cleanup EACCES'), {
        code: 'EACCES',
      });
    }
    return remove(job, ...args);
  };
  const saved = await receive(
    primary.id,
    'reference:saved-cleanup-failure',
    retainedSource,
  );
  assert.equal(saved.status, 'saved');
  assert.equal(cleanupFailures, 1);
  library.staging.remove = remove;
  const shot = newShot(
    'relocation-primary-shot',
    '保留原镜头',
    { x: 23, y: -49 },
    video.id,
  );
  shot.nodes.push({
    id: 'relocation-original-text',
    type: 'text',
    text: '原镜头文字、参数与顺序 🎬\n保持原样',
    position: { x: 420, y: 60 },
  });
  const grouped = groupMaterials(
    shot,
    shot.nodes.map((node) => node.id),
    'relocation-group',
  );
  grouped.groups[0].parameters.ratio = '9:16';
  grouped.groups[0].parameters.duration = 12;
  const workspace = await library.generation.saveWorkspace(primary.id, {
    version: 1,
    revision: 0,
    shots: [grouped],
  });
  const desired = structuredClone(workspace);
  desired.shots[0].nodes.push({
    id: 'draft-only-text',
    type: 'text',
    text: '未提交镜头内容不因找回目录而应用',
    position: { x: -20, y: 444 },
  });
  await library.drafts.protect(primary, {
    sessionId: 'relocation-workspace',
    seq: 9,
    baseline: workspace,
    workspace: desired,
  });
  await library.editDrafts.protect(primary, {
    kind: 'name',
    sessionId: 'relocation-name',
    seq: 7,
    baseline: primary.name,
    target: '  原始未提交名称输入 🎬  ',
  });
  // A real pause handle leaves the complete result queued, while normal project
  // writes may still save a reference to it. Never handwrite a queue record.
  library.saves.pauseLocalReferences();
  const queued = await receive(
    pending.id,
    'reference:queued-root-relocation',
    queuedSource,
  );
  assert.equal(queued.status, 'ready');
  const pendingShot = newShot('pending-shot', '引用暂存的镜头', {
    x: 200,
    y: 300,
  });
  pendingShot.nodes.push({
    id: 'pending-reference',
    type: 'asset',
    assetId: queued.id,
    textOverride: '镜头引用中的覆盖文字不改源文件',
    position: { x: 80, y: 100 },
  });
  const pendingWorkspace = await library.generation.saveWorkspace(pending.id, {
    version: 1,
    revision: 0,
    shots: [pendingShot],
  });
  const settings = library.interactions.get();
  settings.longPressSplit = false;
  library.interactions.save(settings);
  library.store.set('relocationOpaqueSetting', {
    value: '不能白名单重建 settings',
    count: 29,
  });
  await writeFile(
    join(root, '用户自己的说明.txt'),
    '根目录用户文件不可移动或清理',
    { flag: 'wx' },
  );
  await writeFile(
    join(app, 'staging', '用户另放的文件.txt'),
    '不属于任何任务的原文件',
    { flag: 'wx' },
  );
  const projects = await Promise.all(
    [primary, independent, pending].map((p) => library.projects.open(p.id)),
  );
  const asset = projects[0].assets.find((item) => item.id === saved.id);
  assert.ok(asset);
  state = {
    writerCommit,
    app,
    root,
    projects,
    jobs: library.store.jobs(),
    saved,
    queued,
    workspace,
    pendingWorkspace,
    settings,
    draft: (await library.drafts.list(primary.id)).drafts[0],
    nameDraft: (await library.editDrafts.list(primary.id)).drafts[0],
    savedMediaRelative: join(primary.folder, asset.relativePath),
    rootFiles: [],
    appFiles: [],
    sourceFiles: [],
  };
} finally {
  await library.close();
}
const collect = async (directory, prefix = '') => {
  const result = [];
  for (const entry of await readdir(join(directory, prefix), {
    withFileTypes: true,
  })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...(await collect(directory, path)));
    else {
      assert.equal(entry.isFile(), true);
      const bytes = await readFile(join(directory, path));
      result.push({ path, size: bytes.length, sha256: hash(bytes) });
    }
  }
  return result;
};
state.rootFiles = await collect(root);
state.appFiles = (await collect(app)).filter(
  ({ path }) => !['app.sqlite', 'app-backup-anchor.json'].includes(path),
);
state.sourceFiles = await Promise.all(
  files.map(async (file) => ({
    path: relative(data, file),
    size: (await lstat(file)).size,
    sha256: hash(await readFile(file)),
  })),
);
state.anchor = JSON.parse(
  await readFile(join(app, 'app-backup-anchor.json'), 'utf8'),
);
assert.equal(state.anchor.format, 'infinite-afflatus-app-backup-anchor');
assert.equal(state.anchor.version, 1);
assert.equal(state.anchor.root.path, root);
assert.equal(state.anchor.migration, null);
assert.equal(state.anchor.initializing, null);
await writeFile(
  join(data, 'root-relocation-history.json'),
  JSON.stringify(state, null, 2),
  { flag: 'wx' },
);
console.log(
  'PASS archived Library, paused queue, both draft services and stable v1 anchor wrote relocation history',
);
