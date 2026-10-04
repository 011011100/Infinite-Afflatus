import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AppBackupRecovery } from '../src/main/backups/app-backup-recovery';
import type { MigrationJournal } from '../src/main/migration/manifest';
import { updateProject } from '../src/main/projects/project-database';
import { SaveQueue } from '../src/main/saving/save-queue';
import { Library } from '../src/main/storage/library';
import { appBackupFixture, backupHash } from './fixtures/app-backup';

test('after same-root index recovery, replacing the active database with an older saved acknowledgement cannot delete the sole ready result', async (t) => {
  const f = await appBackupFixture(t);
  const cleanup = t.mock.method(f.staging, 'remove', async () => {
    throw Object.assign(new Error('fixture retains a saved ready result'), {
      code: 'EACCES',
    });
  });
  const queue = new SaveQueue(f.store, f.projects, f.gate, f.staging, () => {});
  try {
    queue.start();
    await queue.idle();
  } finally {
    cleanup.mock.restore();
  }
  assert.equal(f.store.job(f.job.id).status, 'saved');
  const asset = (await f.projects.open(f.first.project.id)).assets[0];
  assert.ok(asset);
  const older = await f.backups.create();
  const oldDatabase = join(f.app, 'app-backups', older.id, 'app.sqlite');
  await f.close();
  await fs.unlink(join(f.root, f.first.project.folder, asset.relativePath));
  assert.deepEqual(await fs.readFile(f.staging.path(f.job.id)), f.bytes);
  await fs.writeFile(
    f.database,
    'current app database corrupted after the older snapshot',
  );
  const recovery = new AppBackupRecovery(f.app);
  await recovery.restore((await recovery.preview(older.id)).token);
  const current = await Library.open(f.app, f.root);
  try {
    await current.saves.idle();
    assert.equal(current.store.root, f.root);
    assert.deepEqual(current.store.jobs(), []);
    assert.deepEqual(await fs.readFile(f.staging.path(f.job.id)), f.bytes);
  } finally {
    await current.close();
  }
  // Root path and directory identity are unchanged. Only the independent and
  // in-database generation pair can distinguish this real older application DB.
  await fs.copyFile(oldDatabase, f.database);
  const oldBytes = await fs.readFile(f.database);
  await assert.rejects(Library.open(f.app, f.root), /代际|旧|恢复|标记/);
  assert.deepEqual(await fs.readFile(f.database), oldBytes);
  assert.deepEqual(await fs.readFile(f.staging.path(f.job.id)), f.bytes);
  await assert.rejects(
    fs.readFile(join(f.root, f.first.project.folder, asset.relativePath)),
    { code: 'ENOENT' },
  );
});

test('a target-direction cleanup failure cannot replay an older verifying database with the same migration journal id', async (t) => {
  const f = await appBackupFixture(t);
  await f.close();
  const library = await Library.open(f.app, f.root);
  const target = join(f.base, '迁移后唯一媒体');
  await fs.mkdir(target);
  const captured = join(f.base, 'real-verifying-app.sqlite');
  let sourceMedia = '';
  let targetMedia = '';
  let capturedJournal: MigrationJournal | null = null;
  let deniedCleanup = 0;
  let stop = () => {};
  const originalUnlink = fs.unlink;
  const mock = t.mock.method(
    fs,
    'unlink',
    async (...args: Parameters<typeof fs.unlink>) => {
      if (sourceMedia && String(args[0]) === sourceMedia) {
        deniedCleanup++;
        throw Object.assign(new Error('fixture old source is locked'), {
          code: 'EACCES',
        });
      }
      return originalUnlink(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    await library.saves.idle();
    const asset = (await library.projects.open(f.first.project.id)).assets[0];
    assert.ok(asset);
    sourceMedia = join(f.root, f.first.project.folder, asset.relativePath);
    targetMedia = join(target, f.first.project.folder, asset.relativePath);
    stop = library.subscribe(() => {
      if (capturedJournal || library.state().migration?.phase !== 'verifying')
        return;
      // Capture a genuine synchronous old SQLite state before root switch; do
      // not fabricate switched/id or rewrite journal fingerprints in the fixture.
      const db = new DatabaseSync(f.database, { readOnly: true });
      try {
        capturedJournal = JSON.parse(
          String(
            db
              .prepare('SELECT value FROM settings WHERE key=?')
              .get('migration')?.value,
          ),
        );
        db.prepare('VACUUM INTO ?').run(captured);
      } finally {
        db.close();
      }
    });
    const preview = await library.migration.prepare(target);
    await library.migration.start(preview.token);
    await library.migration.idle();
    assert.ok(capturedJournal);
    assert.equal(
      (capturedJournal as MigrationJournal).status.id,
      preview.token,
    );
    assert.equal((capturedJournal as MigrationJournal).switched, false);
    assert.equal(
      (capturedJournal as MigrationJournal).status.phase,
      'verifying',
    );
    assert.equal(library.store.root, target);
    assert.equal(library.state().migration?.id, preview.token);
    assert.equal(library.state().migration?.phase, 'cleaning');
    assert.equal(
      library.store.get<MigrationJournal>('migration')?.switched,
      true,
    );
    assert.equal(deniedCleanup, 1);
    assert.equal(await backupHash(targetMedia), f.job.sha256);
  } finally {
    stop();
    mock.mock.restore();
    syncBuiltinESMExports();
    await library.close();
  }
  // Only the target now has the media bytes. An old unswitched cleanup would
  // treat that exact target fingerprint as disposable and delete the last copy.
  await fs.unlink(sourceMedia);
  await fs.copyFile(captured, f.database);
  const replacement = await fs.readFile(f.database);
  let reopened: Library | null = null;
  try {
    reopened = await Library.open(f.app, f.root);
    assert.equal(
      reopened.store.root,
      target,
      'Any accepted recovery must converge to the independent target direction',
    );
    await reopened.saves.idle();
  } catch (error) {
    if (reopened) throw error;
    assert.match(String(error), /迁移|代际|旧|恢复|目录/);
    assert.deepEqual(await fs.readFile(f.database), replacement);
  } finally {
    await reopened?.close();
  }
  assert.equal(await backupHash(targetMedia), f.job.sha256);
  await assert.rejects(fs.readFile(sourceMedia), { code: 'ENOENT' });
});

test('cutover database or independent-anchor publication failures preserve both copies until a restart safely converges to target', async (t) => {
  for (const failedStep of [
    'commit-location',
    'after-cutover',
    'commit-location-edited-target',
  ] as const) {
    await t.test(failedStep, async (t) => {
      const f = await appBackupFixture(t);
      await f.close();
      const library = await Library.open(f.app, f.root);
      const target = join(f.base, `cutover-${failedStep}`);
      await fs.mkdir(target);
      let sourceMedia = '';
      let targetMedia = '';
      let injected = 0;
      const fail = () => {
        injected++;
        throw Object.assign(
          new Error(
            `fixture ${failedStep} failed after durable switching intent`,
          ),
          { code: 'EIO' },
        );
      };
      const mock = failedStep.startsWith('commit-location')
        ? t.mock.method(library.store, 'commitLocation', fail)
        : t.mock.method(library.backups, 'afterCutover', async () => fail());
      try {
        await library.saves.idle();
        const asset = (await library.projects.open(f.first.project.id))
          .assets[0];
        assert.ok(asset);
        sourceMedia = join(f.root, f.first.project.folder, asset.relativePath);
        targetMedia = join(target, f.first.project.folder, asset.relativePath);
        const preview = await library.migration.prepare(target);
        await library.migration.start(preview.token);
        try {
          await library.migration.idle();
        } catch (error) {
          assert.match(String(error), /fixture|重开|迁移|切换/);
        }
        assert.equal(injected, 1);
        assert.equal(
          library.store.root,
          failedStep.startsWith('commit-location') ? f.root : target,
        );
        assert.equal(
          await backupHash(sourceMedia),
          f.job.sha256,
          'No same-process rollback may delete the original media',
        );
        assert.equal(
          await backupHash(targetMedia),
          f.job.sha256,
          'No same-process rollback may delete the fully verified target',
        );
        assert.equal(
          library.gate.isBlocked,
          true,
          'Ambiguous cutover cannot admit more project writes before restart',
        );
      } finally {
        mock.mock.restore();
        await library.close();
      }
      if (failedStep === 'commit-location-edited-target') {
        const sourceDatabase = join(
          f.root,
          f.first.project.folder,
          'project.sqlite',
        );
        const targetDatabase = join(
          target,
          f.first.project.folder,
          'project.sqlite',
        );
        // A genuine valid project edit keeps schema and asset identity intact.
        // It must still break the exact pre-commit copy proof.
        updateProject(
          targetDatabase,
          { name: '切换中断后外部编辑的合法名称' },
          f.first.project,
        );
        const files = [sourceDatabase, targetDatabase, f.database];
        const before = await Promise.all(
          files.map((file) => fs.readFile(file)),
        );
        await assert.rejects(Library.open(f.app, f.root), /变化|切换|路由/);
        assert.deepEqual(
          await Promise.all(files.map((file) => fs.readFile(file))),
          before,
        );
        assert.equal(await backupHash(sourceMedia), f.job.sha256);
        assert.equal(await backupHash(targetMedia), f.job.sha256);
        return;
      }
      const reopened = await Library.open(f.app, f.root);
      try {
        await reopened.saves.idle();
        assert.equal(reopened.store.root, target);
        assert.equal(
          (await reopened.projects.open(f.first.project.id)).assets[0]?.sha256,
          f.job.sha256,
        );
        assert.equal(await backupHash(targetMedia), f.job.sha256);
      } finally {
        await reopened.close();
      }
    });
  }
});
