import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppBackupRecovery } from '../src/main/backups/app-backup-recovery';
import { ProjectEditDraftService } from '../src/main/drafts/project-edit-draft-service';
import { WorkspaceDraftService } from '../src/main/drafts/workspace-draft-service';
import { createProjectDatabase } from '../src/main/projects/project-database';
import { AppStore } from '../src/main/storage/app-store';
import { Library } from '../src/main/storage/library';
import type { AppBackupRecoveryReport } from '../src/shared/app-backup';
import { emptyWorkspace, newShot } from '../src/shared/generation/workspace';
import { appBackupFixture } from './fixtures/app-backup';

test('an interrupted database publication resumes from durable intent and preserves original SQLite sidecars', async (t) => {
  const f = await appBackupFixture(t);
  const backup = await f.backups.create();
  await f.close();
  const damaged = Buffer.from(
    'the damaged original must survive an interrupted replacement',
  );
  const sidecar = Buffer.from('original WAL must stay byte exact');
  await fs.writeFile(f.database, damaged);
  await fs.writeFile(`${f.database}-wal`, sidecar);
  const recovery = new AppBackupRecovery(f.app);
  const preview = await recovery.preview(backup.id);
  const originalLink = fs.link;
  let interrupted = false;
  const mock = t.mock.method(
    fs,
    'link',
    async (...args: Parameters<typeof fs.link>) => {
      if (!interrupted && String(args[1]) === f.database) {
        interrupted = true;
        throw Object.assign(new Error('fixture interrupted replacement'), {
          code: 'EIO',
        });
      }
      return originalLink(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      recovery.restore(preview.token),
      /fixture interrupted/,
    );
    assert.equal(
      interrupted,
      true,
      'Failure must hit the actual restore publication',
    );
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  const resumed = new AppBackupRecovery(f.app);
  await resumed.resumePending();
  const store = new AppStore(f.database, f.root, { mode: 'existing' });
  let report: AppBackupRecoveryReport | null;
  try {
    report = store.get<AppBackupRecoveryReport>('appBackupRecovery');
    assert.deepEqual(store.jobs(), []);
    assert.deepEqual(store.get('interactions'), f.settings);
  } finally {
    await store.close();
  }
  assert.ok(report);
  assert.equal(report.backupId, backup.id);
  assert.deepEqual(
    await fs.readFile(join(report.retainedDirectory, 'app.sqlite')),
    damaged,
  );
  assert.deepEqual(
    await fs.readFile(join(report.retainedDirectory, 'app.sqlite-wal')),
    sidecar,
  );
  const after = await fs.readFile(f.database);
  await new AppBackupRecovery(f.app).resumePending();
  assert.deepEqual(await fs.readFile(f.database), after);
  assert.deepEqual(await fs.readFile(f.staging.path(f.job.id)), f.bytes);
});

test('a user replacement at the interrupted publication path prevents resume and is never overwritten', async (t) => {
  const f = await appBackupFixture(t);
  const backup = await f.backups.create();
  await f.close();
  await fs.writeFile(f.database, 'original damaged database');
  const recovery = new AppBackupRecovery(f.app);
  const preview = await recovery.preview(backup.id);
  const originalLink = fs.link;
  let interrupted = false;
  const mock = t.mock.method(
    fs,
    'link',
    async (...args: Parameters<typeof fs.link>) => {
      if (!interrupted && String(args[1]) === f.database) {
        interrupted = true;
        throw Object.assign(new Error('fixture interrupted replacement'), {
          code: 'EIO',
        });
      }
      return originalLink(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      recovery.restore(preview.token),
      /fixture interrupted/,
    );
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(interrupted, true);
  const replacement = Buffer.from(
    'a user supplied a different app.sqlite after interruption',
  );
  await fs.writeFile(f.database, replacement, { flag: 'wx' });
  await assert.rejects(new AppBackupRecovery(f.app).resumePending());
  assert.deepEqual(await fs.readFile(f.database), replacement);
  assert.deepEqual(await fs.readFile(f.staging.path(f.job.id)), f.bytes);
});

test('resume refuses newly added managed projects or crash drafts even when all preexisting files and staging stay unchanged', async (t) => {
  for (const added of [
    'workspace-draft',
    'project-edit-draft',
    'project',
  ] as const) {
    await t.test(added, async (t) => {
      const f = await appBackupFixture(t);
      const backup = await f.backups.create();
      await f.close();
      const damaged = Buffer.from(
        'original damaged app database remains retained',
      );
      await fs.writeFile(f.database, damaged);
      const recovery = new AppBackupRecovery(f.app);
      const preview = await recovery.preview(backup.id);
      const originalLink = fs.link;
      let interrupted = false;
      const mock = t.mock.method(
        fs,
        'link',
        async (...args: Parameters<typeof fs.link>) => {
          if (!interrupted && String(args[1]) === f.database) {
            interrupted = true;
            throw new Error('fixture pause before publication');
          }
          return originalLink(...args);
        },
      );
      syncBuiltinESMExports();
      try {
        await assert.rejects(recovery.restore(preview.token), /fixture pause/);
      } finally {
        mock.mock.restore();
        syncBuiltinESMExports();
      }
      assert.equal(interrupted, true);
      const intentPath = join(f.app, 'app-backup-restore.json');
      const intentBytes = await fs.readFile(intentPath);
      const intent = JSON.parse(intentBytes.toString());
      const retainedOriginal = join(intent.retained.path, 'app.sqlite');
      const candidate = join(intent.retained.path, 'new-app.sqlite');
      const candidateBefore = await fs.readFile(candidate);
      let newFile: string;
      if (added === 'workspace-draft') {
        const drafts = new WorkspaceDraftService(f.app);
        const baseline = emptyWorkspace();
        const shot = newShot('new-protected-shot', '新增暂存引用', {
          x: 1,
          y: 2,
        });
        shot.nodes.push({
          id: 'new-protected-node',
          type: 'asset',
          assetId: f.job.id,
          position: { x: 4, y: 5 },
        });
        try {
          await drafts.protect(f.first.project, {
            sessionId: 'after-intent',
            seq: 1,
            baseline,
            workspace: { ...baseline, shots: [shot] },
          });
        } finally {
          await drafts.close();
        }
        newFile = join(
          f.app,
          'workspace-drafts',
          `${f.first.project.id}.after-intent.json`,
        );
      } else if (added === 'project-edit-draft') {
        const drafts = new ProjectEditDraftService(f.app);
        try {
          await drafts.protect(f.first.project, {
            kind: 'name',
            sessionId: 'after-intent',
            seq: 1,
            baseline: f.first.project.name,
            target: '中断后新增的名称输入',
          });
        } finally {
          await drafts.close();
        }
        newFile = join(
          f.app,
          'project-edit-drafts',
          `${f.first.project.id}.after-intent.json`,
        );
      } else {
        const id = randomUUID();
        const directory = join(f.root, id);
        await fs.mkdir(directory);
        newFile = join(directory, 'project.sqlite');
        createProjectDatabase(newFile, {
          id,
          folder: id,
          name: '中断后新增的项目',
          updatedAt: new Date().toISOString(),
        });
      }
      const newBytes = await fs.readFile(newFile);
      await assert.rejects(new AppBackupRecovery(f.app).resumePending());
      assert.deepEqual(await fs.readFile(newFile), newBytes);
      assert.deepEqual(await fs.readFile(retainedOriginal), damaged);
      assert.deepEqual(await fs.readFile(candidate), candidateBefore);
      assert.deepEqual(await fs.readFile(intentPath), intentBytes);
      assert.deepEqual(await fs.readFile(f.staging.path(f.job.id)), f.bytes);
      await assert.rejects(fs.readFile(f.database), { code: 'ENOENT' });
    });
  }
});

test('startup recovery is a read-only no-op for a missing userData directory and first Library creation still succeeds', async (t) => {
  const base = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'afflatus-backup-first-start-')),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const app = join(base, 'not-created-yet', 'profile');
  const root = join(base, 'projects');
  await new AppBackupRecovery(app).resumePending();
  await assert.rejects(fs.stat(app), { code: 'ENOENT' });
  const library = await Library.open(app, root);
  try {
    assert.equal(library.store.root, root);
    assert.deepEqual(library.store.projects(), []);
    assert.deepEqual(library.store.jobs(), []);
  } finally {
    await library.close();
  }
});
