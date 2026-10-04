// Fixed historical business code only. This creates a real saved result; it
// never handwrites a job or copies current storage formats into an old profile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, data, writerCommit] = process.argv.slice(2);
assert.ok(source && data);
assert.equal(writerCommit, 'dd0a849ac0407ea81fe9c38ebcf1982ce373128e');
const { Library } = await import(
  pathToFileURL(join(source, 'src/main/storage/library.ts')).href
);
const app = join(data, '应用数据 with spaces');
const root = join(data, '原项目 中文');
const original = join(data, '原始合成素材.txt');
const otherSource = join(data, '无关源文件.txt');
await writeFile(original, '历史唯一完整结果，需要保存原字节 🎬\n'.repeat(97), {
  flag: 'wx',
});
await writeFile(otherSource, '另一个项目的素材与源文件不得变化。', {
  flag: 'wx',
});
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const library = await Library.open(app, root);
const resultKey = 'reference:historical-saved-ready';
let failedCleanups = 0;
try {
  const project = await library.projects.create('已保存结果恢复保护');
  const independent = await library.projects.create('不相关项目');
  const remove = library.staging.remove.bind(library.staging);
  library.staging.remove = async (job, ...rest) => {
    if (job.resultKey === resultKey) {
      failedCleanups++;
      throw Object.assign(new Error('Fixture EACCES only after durable save'), {
        code: 'EACCES',
      });
    }
    return remove(job, ...rest);
  };
  const ingest = async (projectId, key, file) => {
    const result = await library.acceptResult(
      {
        projectId,
        resultKey: key,
        name: '历史参考文本.txt',
        kind: 'text',
        usage: 'reference',
        extension: 'txt',
      },
      createReadStream(file),
    );
    await library.saves.idle();
    const job = library.store.job(result.id);
    assert.equal(job.status, 'saved');
    assert.equal(job.sha256, await hash(file));
    return job;
  };
  const job = await ingest(project.project.id, resultKey, original);
  await ingest(
    independent.project.id,
    'reference:unrelated-saved',
    otherSource,
  );
  assert.equal(
    failedCleanups,
    1,
    'Fault occurs only at real post-commit cleanup',
  );
  const snapshot = await library.projects.open(project.project.id);
  const other = await library.projects.open(independent.project.id);
  const [asset] = snapshot.assets;
  assert.ok(asset && asset.id === job.id);
  assert.equal(job.outputRelativePath, asset.relativePath);
  const ready = library.staging.path(job.id);
  const media = join(root, snapshot.project.folder, asset.relativePath);
  assert.deepEqual(await readFile(ready), await readFile(original));
  assert.deepEqual(await readFile(media), await readFile(original));
  library.store.set('savedStagingHistoryPreference', {
    value: '保留原设置 ✓',
    count: 13,
  });
  await library.editDrafts.protect(snapshot.project, {
    kind: 'name',
    sessionId: 'saved-ready-history',
    seq: 7,
    baseline: snapshot.project.name,
    target: '不相关的未确认名称输入',
  });
  const draft = (await library.editDrafts.list(snapshot.project.id)).drafts[0];
  const userFile = join(app, 'staging', '用户自己放的文件.txt');
  await writeFile(userFile, '不属于任务，不可删除', { flag: 'wx' });
  const state = {
    writerCommit,
    app,
    root,
    original,
    media,
    ready,
    project: snapshot,
    independent: other,
    job,
    jobs: library.store.jobs(),
    draft,
    sha256: job.sha256,
    retained: [],
  };
  await library.close();
  for (const file of [
    original,
    otherSource,
    userFile,
    join(root, snapshot.project.folder, 'project.sqlite'),
    join(root, other.project.folder, 'project.sqlite'),
    ...other.assets.map((item) =>
      join(root, other.project.folder, item.relativePath),
    ),
    join(
      app,
      'project-edit-drafts',
      `${snapshot.project.id}.${draft.sessionId}.json`,
    ),
  ])
    state.retained.push({ file, sha256: await hash(file) });
  await writeFile(
    join(data, 'saved-staging-history.json'),
    JSON.stringify(state, null, 2),
    { flag: 'wx' },
  );
} finally {
  await library.close();
}
