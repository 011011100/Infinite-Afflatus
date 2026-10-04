import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppBackupRecovery } from '../../src/main/backups/app-backup-recovery';
import { AppBackupService } from '../../src/main/backups/app-backup-service';
import { AppStore } from '../../src/main/storage/app-store';
import { Library } from '../../src/main/storage/library';
import { WriteGate } from '../../src/main/storage/write-gate';
import {
  assertLegacyBackupFiles,
  type LegacyAppBackupState,
} from './app-backup-legacy-history';

const file = process.argv[2];
assert.ok(file);
const state: LegacyAppBackupState = JSON.parse(await readFile(file, 'utf8'));
if (state.mode === 'saved-ready') {
  const library = await Library.open(state.app, state.root);
  try {
    await library.saves.idle();
    assert.equal(library.store.root, state.root);
    assert.deepEqual(library.store.jobs(), []);
    assert.deepEqual(
      await library.projects.open(state.project.project.id),
      state.project,
    );
    assert.deepEqual(
      await library.projects.open(state.independent.project.id),
      state.independent,
    );
    const recovery = await library.backups.list();
    assert.equal(recovery.recovery?.retainedJobCount, 1);
    await assertLegacyBackupFiles(state);
  } finally {
    await library.close();
  }
} else {
  // This legacy complex state is explicitly unsupported for automatic backup
  // restoration. Do not start ordinary migration recovery as a substitute.
  const store = new AppStore(join(state.app, 'app.sqlite'), state.root, {
    mode: 'existing',
  });
  const gate = new WriteGate();
  const backups = new AppBackupService(store, state.app, gate);
  try {
    await assert.rejects(backups.initialize(), /迁移|原/);
    assert.deepEqual(store.get('migration'), state.journal);
    await new AppBackupRecovery(state.app).list();
    await assertLegacyBackupFiles(state);
  } finally {
    await backups.close();
    store.close();
  }
}
