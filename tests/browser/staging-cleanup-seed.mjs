// Fixture bytes are received by immutable old business code, never the current writer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const [base, source, commit] = process.argv.slice(2);
assert.ok(base && source);
assert.equal(commit, '57c753cb92893671ae0ae76c285563b189fbc1c8');
const { Library } = await import(
  pathToFileURL(join(source, 'src/main/storage/library.ts')).href
);
const library = await Library.open(
  join(base, 'profile'),
  join(base, 'projects'),
);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
let project;
try {
  project = (await library.projects.create('历史暂存保护夹具')).project;
  await library.saves.idle();
  await library.gate.block();
  const records = [];
  for (const mode of ['partial', 'ready']) {
    const bytes =
      mode === 'partial'
        ? Buffer.alloc(192 * 1024, 37)
        : Buffer.from('旧版本已经完整接收的参考文本，项目离线时必须保留。');
    const file = join(base, 'inputs', `historical-${mode}.txt`);
    await writeFile(file, bytes, { flag: 'wx' });
    const stream = createReadStream(file, { highWaterMark: 32 * 1024 });
    const controller = new AbortController();
    const job = await library.acceptResult(
      {
        projectId: project.id,
        resultKey: `reference:historical-${mode}`,
        name: `historical-${mode}.txt`,
        kind: 'text',
        usage: 'reference',
        extension: 'txt',
      },
      stream,
      {
        signal: controller.signal,
        onProgress: ({ phase, bytes }) => {
          if (mode === 'partial' && phase === 'receiving' && bytes > 0)
            controller.abort();
        },
      },
    );
    await finished(stream, { cleanup: true }).catch(() => undefined);
    const staged = join(
      library.staging.directory,
      `${job.id}.${mode === 'partial' ? 'part' : 'ready'}`,
    );
    const content = await readFile(staged);
    assert.deepEqual(content, bytes.subarray(0, job.size));
    if (mode === 'partial') {
      assert.equal(job.status, 'failed');
      assert.equal(job.error, '接收结果已取消');
      assert.ok(job.size > 0 && job.size < bytes.length);
    } else {
      assert.equal(job.status, 'ready');
      assert.equal(job.sha256, digest(bytes));
      assert.equal(job.size, bytes.length);
    }
    records.push({
      job,
      file: staged,
      sha256: digest(content),
      source: file,
      sourceSha256: digest(bytes),
    });
  }
  assert.equal(library.store.get('stagingPartOwnership'), null);
  await writeFile(
    join(base, 'historical.json'),
    JSON.stringify({ commit, project, records }),
  );
} finally {
  await library.close();
}
assert.ok(project);
// Production SaveQueue encounters a real unavailable project. It must retain the
// complete ready file; the independent UI test project remains writable.
await rename(
  join(base, 'projects', project.folder, 'project.sqlite'),
  join(base, 'historical-project.sqlite.offline'),
);
