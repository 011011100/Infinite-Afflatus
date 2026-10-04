import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppBackupRecovery } from '../src/main/backups/app-backup-recovery';
import { Library } from '../src/main/storage/library';
import { appBackupFixture, backupHash } from './fixtures/app-backup';

test('a prepared anchor without a migration journal does not permanently lock the original library on restart', async (t) => {
  const f = await appBackupFixture(t);
  const old = await f.backups.create();
  const target = join(f.base, '尚未开始的迁移');
  await mkdir(target);
  await f.backups.beforeMigration({
    token: randomUUID(),
    source: f.root,
    target,
    projectCount: 2,
    bytes: 0,
  });
  // No new journal and no copied files: interruption between durable invalidation
  // and the first migration SQLite write. Old backup permission stays invalid.
  await f.close();
  const library = await Library.open(f.app, f.root);
  try {
    await library.saves.idle();
    assert.equal(library.store.root, f.root);
    assert.equal(library.store.projects().length, 2);
    await assert.rejects(new AppBackupRecovery(f.app).preview(old.id));
    const fresh = await library.backups.create();
    assert.equal(fresh.restorable, true);
  } finally {
    await library.close();
  }
});

test('real migration invalidates old backups before copying and refuses an old app database after moving the sole media', async (t) => {
  const f = await appBackupFixture(t);
  await f.close();
  const library = await Library.open(f.app, f.root);
  const target = join(f.base, '实际迁移的目标 中文');
  await mkdir(target);
  let sourceBackup = '';
  let backupId = '';
  let media = '';
  let mediaHash = '';
  try {
    await library.saves.idle();
    const asset = (await library.projects.open(f.first.project.id)).assets[0];
    assert.ok(asset);
    const old = await library.backups.create();
    backupId = old.id;
    sourceBackup = join(f.app, 'app-backups', old.id, 'app.sqlite');
    const preview = await library.migration.prepare(target);
    await library.migration.start(preview.token);
    await library.migration.idle();
    assert.equal(library.store.root, target);
    assert.equal(library.state().migration?.phase, 'completed');
    assert.equal(library.state().migration?.id, preview.token);
    media = join(target, f.first.project.folder, asset.relativePath);
    mediaHash = await backupHash(media);
    assert.equal(mediaHash, f.job.sha256);
    await assert.rejects(
      readFile(join(f.root, f.first.project.folder, asset.relativePath)),
      { code: 'ENOENT' },
    );
  } finally {
    await library.close();
  }
  const recovery = new AppBackupRecovery(f.app);
  await assert.rejects(recovery.preview(backupId));
  assert.equal(await backupHash(media), mediaHash);
  // User replaces app.sqlite with a real old snapshot. The independent anchor
  // must reject it before a saved/migration worker has a chance to run.
  await copyFile(sourceBackup, f.database);
  const replacement = await readFile(f.database);
  await assert.rejects(Library.open(f.app, f.root), /旧|迁移|目录|恢复/);
  assert.deepEqual(await readFile(f.database), replacement);
  assert.equal(await backupHash(media), mediaHash);
});
