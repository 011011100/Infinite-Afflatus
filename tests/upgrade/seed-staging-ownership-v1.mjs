// Only this fixed Git archive supplies historical storage, intake and cleanup logic.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const [source, directory, writerCommit, mode] = process.argv.slice(2);
assert.ok(source && directory);
assert.equal(writerCommit, 'c8bf106b02f6a187c52d6381bd788f5a7f88b0fd');
assert.ok(
  ['owned', 'replaced', 'journal-missing', 'journal-present'].includes(mode),
);
const { Library } = await import(
  pathToFileURL(join(source, 'src/main/storage/library.ts')).href
);
const { StagingCleanupService } = await import(
  pathToFileURL(join(source, 'src/main/saving/staging-cleanup-service.ts')).href
);
const expected = JSON.parse(
  await readFile(join(directory, 'expected.json'), 'utf8'),
);
const project = expected.projects[0].project;
const library = await Library.open(join(directory, 'app'), expected.root);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = [];
const records = [];
try {
  assert.ok(library.stagingCleanup instanceof StagingCleanupService);
  await library.saves.idle();
  await library.gate.block();
  const variants = mode.startsWith('journal-')
    ? ['cancelled', 'cloud', 'ready']
    : ['failed', 'cancelled', 'cloud', 'ready'];
  for (const [index, variant] of variants.entries()) {
    const bytes = Buffer.alloc(
      variant === 'ready' ? 12 * 1024 : 192 * 1024,
      61 + index,
    );
    const input = join(directory, `v1-${variant}.png`);
    await writeFile(input, bytes, { flag: 'wx' });
    sourceFiles.push({
      file: input,
      size: bytes.length,
      sha256: digest(bytes),
    });
    const stream = createReadStream(input, { highWaterMark: 32 * 1024 });
    const controller = new AbortController();
    let observed = 0;
    const job = await library.acceptResult(
      {
        projectId: project.id,
        resultKey: `${variant === 'cloud' ? 'cloud' : 'reference'}:v1-${variant}`,
        name: `所有权v1-${variant}.png`,
        kind: 'image',
        ...(variant === 'cloud' ? {} : { usage: 'reference' }),
        extension: 'png',
      },
      stream,
      {
        signal: controller.signal,
        onProgress: ({ phase, bytes }) => {
          if (phase !== 'receiving') return;
          observed = bytes;
          if (!bytes) return;
          if (variant === 'failed' || variant === 'cloud')
            stream.destroy(new Error('v1 historical source read failed'));
          if (variant === 'cancelled') controller.abort();
        },
      },
    );
    await finished(stream, { cleanup: true }).catch(() => undefined);
    assert.equal(job.size, observed);
    assert.equal(job.status, variant === 'ready' ? 'ready' : 'failed');
    if (variant === 'ready') {
      assert.equal(job.sha256, digest(bytes));
      assert.equal(observed, bytes.length);
    } else {
      assert.equal(job.sha256, '');
      assert.ok(observed > 0 && observed < bytes.length);
      assert.match(
        job.error,
        variant === 'cancelled'
          ? /接收结果已取消/
          : /v1 historical source read failed/,
      );
    }
    const file = join(
      library.staging.directory,
      `${job.id}.${variant === 'ready' ? 'ready' : 'part'}`,
    );
    const wanted = bytes.subarray(0, observed);
    assert.deepEqual(await readFile(file), wanted);
    records.push({
      variant,
      job,
      file,
      size: wanted.length,
      sha256: digest(wanted),
      exists: true,
    });
  }
  const originalOwnership = library.store.get('stagingPartOwnership');
  assert.equal(originalOwnership.version, 1);
  const own = records.filter((record) =>
    ['failed', 'cancelled'].includes(record.variant),
  );
  assert.deepEqual(
    originalOwnership.entries.map((entry) => entry.jobId).sort(),
    own.map((record) => record.job.id).sort(),
  );
  for (const record of own) {
    const entry = originalOwnership.entries.find(
      (item) => item.jobId === record.job.id,
    );
    assert.equal(entry.version, 1);
    assert.equal(entry.directory, library.staging.directory);
    assert.equal(entry.partialSha256, record.sha256);
    assert.equal(entry.sealedFingerprint.size, String(record.size));
    for (const identity of [entry.fileIdentity, entry.directoryIdentity])
      for (const key of ['dev', 'ino', 'birthtimeNs'])
        assert.match(identity[key], /^-?\d+$/);
    assert.equal(entry.cleanup, undefined);
  }
  let execution;
  if (mode.startsWith('journal-')) {
    const target = own[0];
    assert.ok(target);
    const preview = await library.stagingCleanup.preview();
    assert.ok(preview.token);
    assert.deepEqual(
      preview.files.map((entry) => entry.jobId),
      [target.job.id],
    );
    assert.equal(preview.bytes, target.size);
    const deleteJob = library.store.deleteJob;
    const verify = library.staging.ownership.verifyDirectory;
    if (mode === 'journal-missing') {
      library.store.deleteJob = () => {
        throw new Error('historical database finalization fault');
      };
    } else {
      library.staging.ownership.verifyDirectory = async function (entry) {
        await verify.call(this, entry);
        if (entry.cleanup)
          throw new Error('historical directory unavailable after intent');
      };
    }
    try {
      // Both intent formats are persisted by the archived real service after explicit confirmation.
      execution = await library.stagingCleanup.execute(preview.token);
    } finally {
      library.store.deleteJob = deleteJob;
      library.staging.ownership.verifyDirectory = verify;
    }
    assert.equal(execution.removedCount, mode === 'journal-missing' ? 1 : 0);
    assert.equal(
      execution.removedBytes,
      mode === 'journal-missing' ? target.size : 0,
    );
    assert.equal(execution.retained.length, 1);
    assert.match(
      execution.retained[0].reason,
      mode === 'journal-missing'
        ? /historical database finalization fault/
        : /historical directory unavailable after intent/,
    );
    const intent = library.staging.ownership.get(target.job.id)?.cleanup;
    assert.ok(intent);
    assert.equal(intent.job, JSON.stringify(target.job));
    assert.equal(intent.fingerprint.size, String(target.size));
    assert.deepEqual(library.store.job(target.job.id), target.job);
    if (mode === 'journal-missing') {
      target.exists = false;
      await assert.rejects(access(target.file), { code: 'ENOENT' });
    } else assert.equal(digest(await readFile(target.file)), target.sha256);
  }
  const unrelated = join(library.staging.directory, '所有权v1用户文件.part');
  const bytes = Buffer.from('这个文件不属于接收服务，不能认领');
  await writeFile(unrelated, bytes, { flag: 'wx' });
  sourceFiles.push({
    file: unrelated,
    size: bytes.length,
    sha256: digest(bytes),
  });
  await writeFile(
    join(directory, 'staging-ownership-v1-expected.json'),
    JSON.stringify(
      {
        writerCommit,
        mode,
        records,
        sourceFiles,
        jobs: library.store.jobs(),
        ownership: library.store.get('stagingPartOwnership'),
        execution,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
} finally {
  await library.close();
}
