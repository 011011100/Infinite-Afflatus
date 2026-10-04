import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppBackupRecovery } from '../../src/main/backups/app-backup-recovery';
import { AppBackupService } from '../../src/main/backups/app-backup-service';
import { AppStore } from '../../src/main/storage/app-store';
import { WriteGate } from '../../src/main/storage/write-gate';
import {
  assertLegacyBackupFiles,
  legacyAppBackupHistory,
} from './app-backup-legacy-history';
import { fileHash, runNode } from './history';

test('fixed pre-backup saved acknowledgement is isolated on restore; sole ready survives two real Library restarts', async (t) => {
  const { data, state } = await legacyAppBackupHistory(t, 'saved-ready');
  const database = join(state.app, 'app.sqlite');
  const store = new AppStore(database, state.root, { mode: 'existing' });
  const gate = new WriteGate();
  const backups = new AppBackupService(store, state.app, gate);
  let id: string;
  try {
    assert.deepEqual(store.job(state.job.id), state.job);
    await backups.initialize();
    id = (await backups.create()).id;
    await assertLegacyBackupFiles(state);
  } finally {
    await backups.close();
    store.close();
  }
  const damaged = Buffer.from(
    'isolated current app database damaged after historical backup',
  );
  await writeFile(database, damaged);
  const recovery = new AppBackupRecovery(state.app);
  const preview = await recovery.preview(id);
  assert.equal(preview.retainedJobCount, 1);
  const result = await recovery.restore(preview.token);
  assert.deepEqual(
    await readFile(join(result.retainedDirectory, 'app.sqlite')),
    damaged,
  );
  assert.equal(result.report.retainedJobCount, 1);
  const retained = JSON.parse(
    await readFile(
      join(result.retainedDirectory, 'retained-state.json'),
      'utf8',
    ),
  );
  assert.deepEqual(retained.snapshot.jobs, [state.job]);
  assert.deepEqual(retained.snapshot.settings.historicalBackupPreference, {
    unicode: '保留设置 ✓',
    count: 9,
  });
  await assertLegacyBackupFiles(state);
  const contract = join(data, 'app-backup-after-restore.json');
  const archivedFiles = await Promise.all(
    ['app.sqlite', 'retained-state.json'].map(async (name) => {
      const file = join(result.retainedDirectory, name);
      return { file, sha256: await fileHash(file) };
    }),
  );
  await writeFile(
    contract,
    JSON.stringify({
      ...state,
      retained: [...state.retained, ...archivedFiles],
    }),
  );
  for (let restart = 0; restart < 2; restart++)
    await runNode(new URL('./reopen-app-backup-legacy.ts', import.meta.url), [
      contract,
    ]);
  t.diagnostic(
    'Actual old saved task and remaining full ready; current restoration isolates old cleanup authority, two fresh-process normal Library opens keep the only media copy and independent name draft.',
  );
});

test('fixed pre-backup interrupted migration cannot become an automatically restorable backup or delete its sole target', async (t) => {
  const { data, state } = await legacyAppBackupHistory(
    t,
    'migration-verifying',
  );
  const database = join(state.app, 'app.sqlite');
  const before = await readFile(database);
  const store = new AppStore(database, state.root, { mode: 'existing' });
  const gate = new WriteGate();
  const backups = new AppBackupService(store, state.app, gate);
  try {
    assert.equal(state.journal?.status.phase, 'verifying');
    assert.equal(state.journal?.switched, false);
    // Bootstrap may not claim an old destructive journal when its source is
    // already missing. Reject before adding even the new generation setting.
    await assert.rejects(backups.initialize(), /迁移|原/);
    assert.deepEqual(store.get('migration'), state.journal);
    await assertLegacyBackupFiles(state);
  } finally {
    await backups.close();
    store.close();
  }
  assert.deepEqual(await readFile(database), before);
  for (let restart = 0; restart < 2; restart++)
    await runNode(new URL('./reopen-app-backup-legacy.ts', import.meta.url), [
      join(data, 'app-backup-legacy.json'),
    ]);
  t.diagnostic(
    'Actual fixed-writer verifying journal is refused, never replayed by backup inspection; two isolated inspection attempts preserve the sole copied target. Ordinary migration recovery is intentionally not invoked.',
  );
});
