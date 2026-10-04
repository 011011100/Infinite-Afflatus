// Only the pinned Git archive provides business writers. Media is synthetic
// storage-test data; no decoder or cloud service participates in this fixture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const [source, directory, writerCommit, mode] = process.argv.slice(2);
assert.ok(source && directory);
assert.match(writerCommit, /^[a-f0-9]{40}$/);
assert.ok(['saved-ready', 'migration-verifying'].includes(mode));
const { Library } = await import(
  pathToFileURL(join(source, 'src/main/storage/library.ts')).href
);
const app = join(directory, '应用数据 with spaces');
const root = join(directory, '原项目目录 中文');
const target = join(directory, '迁移目标 中文');
await mkdir(target);
const library = await Library.open(app, root);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const { project } = await library.projects.create('唯一媒体不得丢失');
const independent = await library.projects.create('独立项目保留');
const bytes = Buffer.from('历史存储验收：唯一媒体内容 🎬\n'.repeat(96));
if (mode === 'saved-ready') {
  // Real old SaveQueue commits the asset and saved acknowledgement. Its cleanup
  // fails exactly as it could on a locked staging file; no job fields are forged.
  library.staging.remove = async () => {
    throw Object.assign(new Error('fixture locked staging'), {
      code: 'EACCES',
    });
  };
}
const received = await library.acceptResult(
  {
    projectId: project.id,
    resultKey: 'legacy:unique-completed-result',
    name: '唯一素材.mp4',
    kind: 'video',
    extension: 'mp4',
  },
  Readable.from(bytes),
);
await library.saves.idle();
const job = library.store.job(received.id);
assert.equal(job.status, 'saved');
assert.equal(job.sha256, hash(bytes));
const snapshot = await library.projects.open(project.id);
const [asset] = snapshot.assets;
assert.ok(asset && asset.id === job.id);
const media = join(root, project.folder, asset.relativePath);
const ready = library.staging.path(job.id);
library.store.set('historicalBackupPreference', {
  unicode: '保留设置 ✓',
  count: 9,
});
await library.editDrafts.protect(project, {
  kind: 'name',
  sessionId: 'legacy-backup-name',
  seq: 1,
  baseline: project.name,
  target: '旧版本中尚未确认的名称',
});
const unrelated = join(app, 'staging', '用户另放说明.txt');
await writeFile(unrelated, '不是任务，不得清理');
const expected = {
  writerCommit,
  mode,
  app,
  root,
  target,
  project: snapshot,
  independent,
  job,
  media,
  ready,
  bytes: bytes.length,
  sha256: hash(bytes),
  retained: [],
};
for (const file of [
  join(root, independent.project.folder, 'project.sqlite'),
  join(app, 'project-edit-drafts', `${project.id}.legacy-backup-name.json`),
  unrelated,
])
  expected.retained.push({ file, sha256: hash(await readFile(file)) });

if (mode === 'saved-ready') {
  await library.close();
  assert.deepEqual(await readFile(ready), bytes);
  // Isolated failure injection: the committed project copy is lost. The old
  // saved acknowledgement still authorizes deleting the sole remaining ready.
  await unlink(media);
  expected.retained.push({ file: ready, sha256: hash(bytes) });
  expected.retained.push({
    file: join(root, project.folder, 'project.sqlite'),
    sha256: hash(await readFile(join(root, project.folder, 'project.sqlite'))),
  });
  await writeFile(
    join(directory, 'app-backup-legacy.json'),
    JSON.stringify(expected),
  );
} else {
  library.subscribe(() => {
    if (library.state().migration?.phase !== 'verifying') return;
    const journal = library.store.get('migration');
    assert.equal(journal.switched, false);
    assert.ok(journal.files.every((entry) => entry.copied && !entry.cleaned));
    const targetMedia = join(target, project.folder, asset.relativePath);
    assert.deepEqual(readFileSync(targetMedia), bytes);
    // The old unswitched cleanup deletes target copies without requiring the
    // source to remain. Lose the source at this precise real journal boundary.
    unlinkSync(media);
    expected.journal = journal;
    expected.retained.push({ file: targetMedia, sha256: hash(bytes) });
    writeFileSync(
      join(directory, 'app-backup-legacy.json'),
      JSON.stringify(expected),
    );
    process.exit(73);
  });
  const preview = await library.migration.prepare(target);
  await library.migration.start(preview.token);
  await library.migration.idle();
  throw new Error('Historical verifying interruption was not reached');
}
