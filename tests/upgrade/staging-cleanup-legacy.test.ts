import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { test } from 'node:test';
import { STAGING_CANCELLED, Staging } from '../../src/main/saving/staging';
import { StagingCleanupService } from '../../src/main/saving/staging-cleanup-service';
import { AppStore } from '../../src/main/storage/app-store';
import { assertIntegrity } from './checks';
import { type Baseline, fileHash, history, runNode } from './history';
import {
  assertLegacyStagingBytes,
  type HistoricalStagingCleanup,
  type StagingCleanupLegacyContract,
} from './staging-cleanup-contract';

const baseline: Baseline = JSON.parse(
  await readFile(
    new URL('./staging-cleanup-legacy-baseline.json', import.meta.url),
    'utf8',
  ),
);
assert.equal(baseline.commit, '57c753cb92893671ae0ae76c285563b189fbc1c8');

test(`${baseline.name}: cleanup removes only a current owned partial while historical failed/cancelled bytes and complete ready results survive two restarts`, async (t) => {
  const f = await history(t, baseline);
  await runNode(new URL('./seed-staging-cleanup-legacy.mjs', import.meta.url), [
    join(f.base, 'old-code'),
    f.data,
    baseline.commit,
  ]);
  const historical: HistoricalStagingCleanup = JSON.parse(
    await readFile(
      join(f.data, 'staging-cleanup-legacy-expected.json'),
      'utf8',
    ),
  );
  assert.equal(historical.writerCommit, baseline.commit);
  assert.equal(historical.partials.length, 2);
  assert.equal(historical.ready.job.status, 'ready');
  assert.ok(historical.ready.job.sha256);
  assert.match(
    historical.partials[0]?.job.error ?? '',
    /historical source read failed/,
  );
  assert.equal(historical.partials[1]?.job.error, STAGING_CANCELLED);
  const contract: StagingCleanupLegacyContract = {
    app: f.app,
    expected: f.expected,
    historical,
  };
  const store = new AppStore(join(f.app, 'app.sqlite'), f.expected.root);
  const staging = new Staging(join(f.app, 'staging'), store, () => {});
  const cleanup = new StagingCleanupService(staging, store, () => {});
  try {
    assert.equal(
      store.get('stagingPartOwnership'),
      null,
      'the archived writer has no ownership journal',
    );
    await staging.recover();
    await cleanup.recover();
    const inspection = await cleanup.inspect();
    const oldPreview = await cleanup.preview();
    assert.equal(oldPreview.token, null);
    assert.deepEqual(oldPreview.files, []);
    assert.equal(oldPreview.bytes, 0);
    for (const entry of historical.partials) {
      const item = inspection.items.find((item) => item.jobId === entry.job.id);
      assert.ok(item);
      assert.equal(item.canCleanup, false);
      assert.ok(item.reason);
      assert.ok(
        oldPreview.retained.some((item) => item.jobId === entry.job.id),
      );
      assert.ok(
        !JSON.stringify(store.get('stagingPartOwnership')).includes(
          entry.job.id,
        ),
      );
    }
    assert.deepEqual(store.jobs(), historical.jobs);
    await assertLegacyStagingBytes(contract);

    // Positive control is explicitly CURRENT data, never used as the historical writer.
    const file = join(f.data, 'current-owned-reference.png');
    const bytes = Buffer.alloc(128 * 1024, 71);
    await writeFile(file, bytes);
    const controller = new AbortController();
    const stream = createReadStream(file, { highWaterMark: 16 * 1024 });
    const current = await staging.receive(
      {
        projectId: historical.project.id,
        resultKey: 'reference:current-cleanup-control',
        name: '当前版本取消素材.png',
        kind: 'image',
        usage: 'reference',
        extension: 'png',
      },
      stream,
      {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.bytes > 0) controller.abort();
        },
      },
    );
    await finished(stream, { cleanup: true }).catch(() => undefined);
    assert.equal(current.status, 'failed');
    assert.equal(current.error, STAGING_CANCELLED);
    assert.ok(current.size > 0 && current.size < bytes.length);
    const part = join(staging.directory, `${current.id}.part`);
    const before = await fileHash(part);
    const preview = await cleanup.preview();
    assert.ok(preview.token);
    assert.deepEqual(
      preview.files.map((entry) => entry.jobId),
      [current.id],
    );
    assert.equal(preview.bytes, current.size);
    await cleanup.cancel();
    await assert.rejects(cleanup.execute(preview.token));
    assert.equal(
      await fileHash(part),
      before,
      'cancelled preview cannot delete its partial',
    );
    assert.deepEqual(store.job(current.id), current);
    await assertLegacyStagingBytes(contract);

    const confirmed = await cleanup.preview();
    assert.ok(confirmed.token);
    const removed = await cleanup.execute(confirmed.token);
    assert.equal(removed.removedCount, 1);
    assert.equal(removed.removedBytes, current.size);
    await assert.rejects(access(part), { code: 'ENOENT' });
    assert.throws(() => store.job(current.id), /不存在/);
    assert.deepEqual(store.jobs(), historical.jobs);
    contract.cleaned = {
      jobId: current.id,
      file: part,
      source: { file, size: bytes.length, sha256: await fileHash(file) },
    };
    await assertLegacyStagingBytes(contract);
  } finally {
    await cleanup.close();
    await staging.idle();
    store.close();
  }
  const contractFile = join(f.data, 'staging-cleanup-after-current.json');
  await writeFile(contractFile, JSON.stringify(contract));
  for (let restart = 0; restart < 2; restart++)
    await runNode(
      new URL('./reopen-staging-cleanup-legacy.ts', import.meta.url),
      [contractFile],
    );
  await assertLegacyStagingBytes(contract);
  assertIntegrity(join(f.app, 'app.sqlite'));
  for (const entry of f.expected.projects)
    assertIntegrity(
      join(f.expected.root, entry.project.folder, 'project.sqlite'),
    );
  t.diagnostic(
    `Fixed writer ${baseline.commit}: unowned failed/cancelled .part files, complete .ready bytes and all source hashes survive real current cleanup and two independent restarts; only the explicitly current owned control is removed.`,
  );
});
