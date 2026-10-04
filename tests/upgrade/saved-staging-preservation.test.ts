import assert from 'node:assert/strict';
import { access, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Library } from '../../src/main/storage/library';
import { fileHash, runNode } from './history';
import {
  assertSavedStagingState,
  type SavedStagingContract,
  savedStagingHistory,
} from './saved-staging-history';

for (const mode of ['missing', 'mismatch', 'valid'] as const)
  test(`fixed saved+ready survives ordinary startup safely: ${mode}`, async (t) => {
    const { data, state } = await savedStagingHistory(t);
    const contract: SavedStagingContract = { state, mode };
    if (mode === 'missing') await unlink(state.media);
    if (mode === 'mismatch') {
      const wrong = await readFile(state.media);
      wrong[0] = (wrong[0] ?? 0) ^ 0xff;
      await writeFile(state.media, wrong);
      contract.wrongHash = await fileHash(state.media);
      assert.notEqual(contract.wrongHash, state.sha256);
      assert.equal(wrong.length, state.job.size);
    }
    const defaultRoot = join(data, 'unused-default-must-not-appear');
    const opened = await Library.open(state.app, defaultRoot);
    try {
      await opened.saves.idle();
      await assertSavedStagingState(opened, contract);
    } finally {
      await opened.close();
    }
    const file = join(data, 'saved-staging-current.json');
    await writeFile(file, JSON.stringify(contract));
    for (let restart = 0; restart < 2; restart++) {
      const result = await runNode(
        new URL('./reopen-saved-staging.ts', import.meta.url),
        [file],
      );
      assert.match(result.stdout, /PASS ordinary independent Library restart/);
    }
    if (mode === 'missing') {
      // Recover from the complete staging file itself, not a second source copy.
      // Existing health restoration verifies its content and only fills a missing
      // registered destination. The next ordinary startup may then clean ready.
      const repairing = await Library.open(state.app, defaultRoot);
      try {
        const report = await repairing.health.restore(
          state.project.project.id,
          state.job.id,
          state.ready,
        );
        assert.deepEqual(report.issues, []);
        assert.equal(await fileHash(state.media), state.sha256);
        assert.equal(await fileHash(state.ready), state.sha256);
        assert.deepEqual(repairing.store.job(state.job.id), state.job);
      } finally {
        await repairing.close();
      }
      await writeFile(file, JSON.stringify({ ...contract, mode: 'valid' }));
      for (let restart = 0; restart < 2; restart++)
        await runNode(new URL('./reopen-saved-staging.ts', import.meta.url), [
          file,
        ]);
      t.diagnostic(
        'Missing target kept sole ready through three ordinary starts; explicit existing health restore used ready; two further ordinary starts safely cleaned it only after target validation.',
      );
    }
    await assert.rejects(access(defaultRoot), {
      code: 'ENOENT',
    });
  });
