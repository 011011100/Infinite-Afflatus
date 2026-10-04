// Historical business modules come exclusively from the pinned Git archive.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const [source, directory, writerCommit] = process.argv.slice(2);
assert.ok(source && directory);
assert.equal(writerCommit, '57c753cb92893671ae0ae76c285563b189fbc1c8');
const { Library } = await import(
  pathToFileURL(join(source, 'src/main/storage/library.ts')).href
);
const { Staging, STAGING_CANCELLED } = await import(
  pathToFileURL(join(source, 'src/main/saving/staging.ts')).href
);
const expected = JSON.parse(
  await readFile(join(directory, 'expected.json'), 'utf8'),
);
const original = expected.projects[0];
assert.ok(original);
const library = await Library.open(join(directory, 'app'), expected.root);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
try {
  assert.ok(library.staging instanceof Staging);
  assert.equal(library.store.get('stagingPartOwnership'), null);
  await library.saves.idle();
  await library.gate.block();
  const files = [];
  const partials = [];
  let ready;
  for (const mode of ['failed', 'cancelled', 'ready']) {
    const bytes = Buffer.alloc(
      mode === 'ready' ? 12 * 1024 : 192 * 1024,
      mode === 'failed' ? 31 : mode === 'cancelled' ? 47 : 59,
    );
    const file = join(directory, `historical-${mode}.png`);
    await writeFile(file, bytes);
    files.push({ file, size: bytes.length, sha256: hash(bytes) });
    const stream = createReadStream(file, { highWaterMark: 32 * 1024 });
    const controller = new AbortController();
    let observed = 0;
    const job = await library.acceptResult(
      {
        projectId: original.project.id,
        resultKey: `reference:historical-${mode}`,
        name: `旧版${mode}.png`,
        kind: 'image',
        usage: 'reference',
        extension: 'png',
      },
      stream,
      {
        ...(mode === 'cancelled' ? { signal: controller.signal } : {}),
        onProgress: ({ phase, bytes }) => {
          if (phase !== 'receiving') return;
          observed = bytes;
          if (!bytes) return;
          if (mode === 'failed')
            stream.destroy(new Error('historical source read failed'));
          if (mode === 'cancelled') controller.abort();
        },
      },
    );
    await finished(stream, { cleanup: true }).catch(() => undefined);
    assert.equal(
      observed,
      job.size,
      'historical byte progress matches its durable queue record',
    );
    const staged = join(
      library.staging.directory,
      `${job.id}.${mode === 'ready' ? 'ready' : 'part'}`,
    );
    if (mode === 'ready') {
      assert.equal(job.status, 'ready');
      assert.equal(job.size, bytes.length);
      assert.equal(job.sha256, hash(bytes));
      assert.deepEqual(await readFile(staged), bytes);
      ready = { job, file: staged, size: bytes.length, sha256: hash(bytes) };
    } else {
      assert.equal(job.status, 'failed');
      assert.equal(job.sha256, '');
      assert.ok(observed > 0 && observed < bytes.length);
      if (mode === 'cancelled') assert.equal(job.error, STAGING_CANCELLED);
      else assert.match(job.error, /historical source read failed/);
      const wanted = bytes.subarray(0, observed);
      assert.deepEqual(await readFile(staged), wanted);
      partials.push({
        job,
        file: staged,
        size: wanted.length,
        sha256: hash(wanted),
      });
    }
    assert.deepEqual(await readFile(file), bytes);
  }
  assert.ok(ready);
  assert.equal(partials.length, 2);
  assert.equal(
    library.store.get('stagingPartOwnership'),
    null,
    'the fixed writer never creates ownership evidence',
  );
  const unrelated = join(library.staging.directory, '用户自己的文件.part');
  const unrelatedBytes = Buffer.from(
    '历史暂存目录内的用户文件，不能认领或删除',
  );
  await writeFile(unrelated, unrelatedBytes);
  files.push({
    file: unrelated,
    size: unrelatedBytes.length,
    sha256: hash(unrelatedBytes),
  });
  await writeFile(
    join(directory, 'staging-cleanup-legacy-expected.json'),
    JSON.stringify(
      {
        writerCommit,
        project: original.project,
        partials,
        ready,
        files,
        jobs: library.store.jobs(),
      },
      null,
      2,
    ),
  );
} finally {
  await library.close();
}
