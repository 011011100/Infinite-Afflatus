import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Staging } from '../../src/main/saving/staging';
import { StagingCleanupService } from '../../src/main/saving/staging-cleanup-service';
import { AppStore } from '../../src/main/storage/app-store';
import { assertIntegrity } from './checks';
import { type Baseline, history, runNode } from './history';
import {
  assertOwnershipV1Files,
  expectedJobs,
  expectedOwnership,
  type OwnershipV1Contract,
  type OwnershipV1Historical,
} from './staging-ownership-v1-contract';

const baseline: Baseline = JSON.parse(
  await readFile(
    new URL('./staging-ownership-v1-baseline.json', import.meta.url),
    'utf8',
  ),
);
assert.equal(baseline.commit, 'c8bf106b02f6a187c52d6381bd788f5a7f88b0fd');

for (const mode of [
  'owned',
  'replaced',
  'journal-missing',
  'journal-present',
] as const) {
  test(`${baseline.name}/${mode}: fixed ownership and cleanup intents retain their safety boundaries across upgrade and two independent restarts`, async (t) => {
    const f = await history(t, baseline);
    await runNode(new URL('./seed-staging-ownership-v1.mjs', import.meta.url), [
      join(f.base, 'old-code'),
      f.data,
      baseline.commit,
      mode,
    ]);
    const historical: OwnershipV1Historical = JSON.parse(
      await readFile(
        join(f.data, 'staging-ownership-v1-expected.json'),
        'utf8',
      ),
    );
    assert.equal(historical.writerCommit, baseline.commit);
    assert.equal(historical.mode, mode);
    assert.equal(historical.ownership.version, 1);
    assert.ok(
      historical.records.find((record) => record.variant === 'ready')?.job
        .sha256,
    );
    assert.ok(historical.records.find((record) => record.variant === 'cloud'));
    const owned = historical.records.filter((record) =>
      ['failed', 'cancelled'].includes(record.variant),
    );
    assert.equal(owned.length, mode.startsWith('journal-') ? 1 : 2);
    assert.equal(historical.ownership.entries.length, owned.length);
    const contract: OwnershipV1Contract = {
      app: f.app,
      expected: f.expected,
      historical,
      removedIds: [],
      eligibleIds: [],
    };
    if (mode === 'replaced') {
      const changed = owned.find((record) => record.variant === 'failed');
      assert.ok(changed);
      const moved = `${changed.file}.original`;
      await rename(changed.file, moved);
      const bytes = Buffer.from('用户替换到旧暂存路径的文件，绝不能清理。');
      await writeFile(changed.file, bytes, { flag: 'wx' });
      contract.replacement = {
        jobId: changed.job.id,
        original: { file: moved, size: changed.size, sha256: changed.sha256 },
        replacement: {
          file: changed.file,
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      };
    }
    await assertOwnershipV1Files(contract);
    const store = new AppStore(join(f.app, 'app.sqlite'), f.expected.root);
    const staging = new Staging(join(f.app, 'staging'), store, () => {});
    const cleanup = new StagingCleanupService(staging, store, () => {});
    try {
      assert.deepEqual(store.jobs(), historical.jobs);
      assert.deepEqual(store.get('stagingPartOwnership'), historical.ownership);
      // Deliberately no SaveQueue: moving complete results would evade the cleanup preservation check.
      await staging.recover();
      await cleanup.recover();
      if (mode === 'journal-missing') {
        const target = owned[0];
        assert.ok(target);
        assert.equal(target.exists, false);
        assert.equal(historical.execution?.removedCount, 1);
        assert.ok(historical.ownership.entries[0]?.cleanup);
        contract.removedIds = [target.job.id];
        assert.throws(() => store.job(target.job.id), /不存在/);
      } else if (mode === 'journal-present') {
        const target = owned[0];
        assert.ok(target);
        assert.equal(target.exists, true);
        assert.equal(historical.execution?.removedCount, 0);
        assert.ok(historical.ownership.entries[0]?.cleanup);
        contract.eligibleIds = [target.job.id];
      }
      assert.deepEqual(
        store.jobs(),
        expectedJobs(contract),
        'startup only finalizes the already-missing confirmed partial',
      );
      assert.deepEqual(
        store.get('stagingPartOwnership'),
        expectedOwnership(contract),
        'present historical intents and unrelated ownership remain byte-for-byte in value',
      );
      await assertOwnershipV1Files(contract);
      const eligible = mode.startsWith('journal-')
        ? contract.eligibleIds
        : owned
            .filter((record) => record.job.id !== contract.replacement?.jobId)
            .map((record) => record.job.id);
      const preview = await cleanup.preview();
      assert.deepEqual(
        preview.files.map((item) => item.jobId).sort(),
        [...eligible].sort(),
      );
      assert.equal(
        preview.bytes,
        historical.records
          .filter((record) => eligible.includes(record.job.id))
          .reduce((sum, record) => sum + record.size, 0),
      );
      const cloud = historical.records.find(
        (record) => record.variant === 'cloud',
      );
      assert.ok(
        cloud &&
          preview.retained.some(
            (item) => item.jobId === cloud.job.id && !item.canCleanup,
          ),
      );
      if (contract.replacement) {
        const retained = preview.retained.find(
          (item) => item.jobId === contract.replacement?.jobId,
        );
        assert.ok(retained);
        assert.equal(retained.canCleanup, false);
        assert.ok(retained.reason);
      }
      cleanup.cancel();
      if (preview.token)
        await assert.rejects(cleanup.execute(preview.token), /预览已失效/);
      assert.deepEqual(store.jobs(), expectedJobs(contract));
      assert.deepEqual(
        store.get('stagingPartOwnership'),
        expectedOwnership(contract),
      );
      await assertOwnershipV1Files(contract);
      if (!mode.startsWith('journal-')) {
        const fresh = await cleanup.preview();
        assert.ok(fresh.token);
        const removed = await cleanup.execute(fresh.token);
        assert.deepEqual(removed, {
          removedCount: eligible.length,
          removedBytes: preview.bytes,
          retained: [],
        });
        contract.removedIds = [...eligible];
        assert.deepEqual(store.jobs(), expectedJobs(contract));
        assert.deepEqual(
          store.get('stagingPartOwnership'),
          expectedOwnership(contract),
        );
        await assertOwnershipV1Files(contract);
      }
    } finally {
      await cleanup.close();
      await staging.idle();
      store.close();
    }
    const contractFile = join(
      f.data,
      'staging-ownership-v1-after-current.json',
    );
    await writeFile(contractFile, JSON.stringify(contract), { flag: 'wx' });
    for (let restart = 0; restart < 2; restart++)
      await runNode(
        new URL('./reopen-staging-ownership-v1.ts', import.meta.url),
        [contractFile],
      );
    await assertOwnershipV1Files(contract);
    assertIntegrity(join(f.app, 'app.sqlite'));
    for (const project of f.expected.projects)
      assertIntegrity(
        join(f.expected.root, project.project.folder, 'project.sqlite'),
      );
    t.diagnostic(
      `Archived writer ${baseline.commit}, scenario ${mode}: real v1 ownership/sealed hashes${historical.execution ? ' and explicitly confirmed historical cleanup intent' : ''}; sources, complete ready and cloud partial retained across two current-process restarts.`,
    );
  });
}
