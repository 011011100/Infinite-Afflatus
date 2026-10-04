import assert from 'node:assert/strict';
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AppBackupRecovery } from '../src/main/backups/app-backup-recovery';
import { AppBackupService } from '../src/main/backups/app-backup-service';
import { WorkspaceDraftService } from '../src/main/drafts/workspace-draft-service';
import { GenerationService } from '../src/main/generation/generation-service';
import { AppStore } from '../src/main/storage/app-store';
import { newShot } from '../src/shared/generation/workspace';
import { appBackupFixture, backupHash } from './fixtures/app-backup';

test('an online WAL backup includes committed settings and queue but no project or staging bytes', async (t) => {
  const f = await appBackupFixture(t);
  const projectFile = join(f.root, f.first.project.folder, 'project.sqlite');
  const projectBefore = await backupHash(projectFile);
  const writer = new DatabaseSync(f.database);
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    f.store.set('fixturePreference', {
      title: '只在 WAL 中的提交 ✓',
      value: 27,
    });
    assert.ok((await stat(`${f.database}-wal`)).size > 0);
    const backup = await f.backups.create();
    assert.equal(backup.projectCount, 2);
    assert.equal(backup.saveCount, 1);
    assert.equal(backup.appVersion, 'test-version');
    const directory = join(f.app, 'app-backups', backup.id);
    assert.deepEqual((await readdir(directory)).sort(), [
      'app.sqlite',
      'manifest.json',
    ]);
    assert.equal(
      await backupHash(join(directory, 'app.sqlite')),
      backup.sha256,
    );
    assert.equal(
      (await stat(join(directory, 'app.sqlite'))).size,
      backup.bytes,
    );
    const checkpoint = new DatabaseSync(join(directory, 'app.sqlite'), {
      readOnly: true,
    });
    try {
      assert.equal(
        checkpoint.prepare('PRAGMA quick_check').get()?.quick_check,
        'ok',
      );
      assert.deepEqual(
        JSON.parse(
          String(
            checkpoint
              .prepare('SELECT value FROM settings WHERE key=?')
              .get('fixturePreference')?.value,
          ),
        ),
        {
          title: '只在 WAL 中的提交 ✓',
          value: 27,
        },
      );
      assert.deepEqual(
        JSON.parse(
          String(
            checkpoint
              .prepare('SELECT payload FROM saves WHERE id=?')
              .get(f.job.id)?.payload,
          ),
        ),
        f.job,
      );
    } finally {
      checkpoint.close();
    }
    assert.equal(await backupHash(projectFile), projectBefore);
    assert.deepEqual(await readFile(f.staging.path(f.job.id)), f.bytes);
    assert.deepEqual(f.store.jobs(), [f.job]);
  } finally {
    writer.close();
  }
});

test('offline recovery preserves corrupt original database and every SQLite sidecar, without reactivating saved work', async (t) => {
  const f = await appBackupFixture(t);
  const backup = await f.backups.create();
  const projectsBefore = await Promise.all(
    [f.first, f.second].map((p) =>
      backupHash(join(f.root, p.project.folder, 'project.sqlite')),
    ),
  );
  await f.close();
  const original = new Map<string, Buffer>();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const bytes = Buffer.from(
      `original damaged app.sqlite${suffix} must stay byte exact\n`,
    );
    original.set(`app.sqlite${suffix}`, bytes);
    await writeFile(`${f.database}${suffix}`, bytes);
  }
  const recovery = new AppBackupRecovery(f.app, 'test-version');
  const preview = await recovery.preview(backup.id);
  assert.equal(preview.projectCount, 2);
  assert.equal(preview.retainedJobCount, 1);
  const result = await recovery.restore(preview.token);
  for (const [name, bytes] of original)
    assert.deepEqual(
      await readFile(join(result.retainedDirectory, name)),
      bytes,
      name,
    );
  for (const suffix of ['-wal', '-shm', '-journal'])
    await assert.rejects(readFile(`${f.database}${suffix}`), {
      code: 'ENOENT',
    });
  const restored = new AppStore(f.database, f.root, { mode: 'existing' });
  const online = new AppBackupService(restored, f.app, f.gate);
  try {
    assert.deepEqual(restored.get('interactions'), f.settings);
    assert.deepEqual(
      restored.jobs(),
      [],
      'Old task rows remain in retained records, never in the active queue',
    );
    assert.equal(restored.projects().length, 2);
    assert.equal((await online.list()).recovery?.backupId, backup.id);
  } finally {
    await online.close();
    await restored.close();
  }
  assert.deepEqual(await readFile(f.staging.path(f.job.id)), f.bytes);
  assert.deepEqual(
    await Promise.all(
      [f.first, f.second].map((p) =>
        backupHash(join(f.root, p.project.folder, 'project.sqlite')),
      ),
    ),
    projectsBefore,
  );
  await recovery.resumePending();
  assert.deepEqual(await readFile(f.staging.path(f.job.id)), f.bytes);
  assert.equal(
    (await recovery.list()).recovery,
    null,
    'Offline listing never opens the possibly damaged current app database',
  );
});

test('restore confirmation expires when source backup, current app file, or staging set changes', async (t) => {
  for (const changed of ['backup', 'current', 'staging'] as const) {
    await t.test(changed, async (t) => {
      const f = await appBackupFixture(t);
      const backup = await f.backups.create();
      await f.close();
      const recovery = new AppBackupRecovery(f.app);
      const preview = await recovery.preview(backup.id);
      if (changed === 'backup')
        await writeFile(
          join(f.app, 'app-backups', backup.id, 'app.sqlite'),
          'changed backup',
        );
      if (changed === 'current')
        await writeFile(f.database, 'replacement app database');
      if (changed === 'staging')
        await writeFile(
          join(f.app, 'staging', 'new-user-file.txt'),
          'new retained bytes',
        );
      const before = await readFile(f.database);
      await assert.rejects(recovery.restore(preview.token));
      assert.deepEqual(await readFile(f.database), before);
      assert.deepEqual(await readFile(f.staging.path(f.job.id)), f.bytes);
    });
  }
});

test('copied profiles and replaced original root directories cannot authorize a restore', async (t) => {
  const f = await appBackupFixture(t);
  const backup = await f.backups.create();
  await f.close();
  const clone = join(f.base, '另一个应用 profile');
  await cp(f.app, clone, { recursive: true });
  const cloneDatabase = await backupHash(join(clone, 'app.sqlite'));
  await assert.rejects(new AppBackupRecovery(clone).preview(backup.id));
  assert.equal(await backupHash(join(clone, 'app.sqlite')), cloneDatabase);
  const moved = `${f.root}-original`;
  await rename(f.root, moved);
  await mkdir(f.root);
  const userFile = join(f.root, '用户新目录.txt');
  await writeFile(userFile, '保持原样');
  await assert.rejects(new AppBackupRecovery(f.app).preview(backup.id));
  assert.equal(await readFile(userFile, 'utf8'), '保持原样');
  await assert.rejects(
    readFile(join(f.root, f.first.project.folder, 'project.sqlite')),
    { code: 'ENOENT' },
  );
  assert.equal(
    (
      await stat(join(moved, f.first.project.folder, 'project.sqlite'))
    ).isFile(),
    true,
  );
});

test('a checkpoint with an unexpected SQLite sidecar is rejected without trusting or deleting that sidecar', async (t) => {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    await t.test(suffix, async (t) => {
      const f = await appBackupFixture(t);
      const backup = await f.backups.create();
      await f.close();
      const source = join(f.app, 'app-backups', backup.id, 'app.sqlite');
      const databaseBefore = await backupHash(source);
      const sidecar = Buffer.from(`unverified checkpoint sidecar ${suffix}`);
      await writeFile(`${source}${suffix}`, sidecar);
      await assert.rejects(new AppBackupRecovery(f.app).preview(backup.id));
      assert.equal(await backupHash(source), databaseBefore);
      assert.deepEqual(await readFile(`${source}${suffix}`), sidecar);
      assert.deepEqual(await readFile(f.staging.path(f.job.id)), f.bytes);
    });
  }
});

test('recovery refuses to orphan staging-only references in a saved workspace or independent crash draft', async (t) => {
  for (const location of ['workspace', 'crash-draft'] as const) {
    await t.test(location, async (t) => {
      const f = await appBackupFixture(t);
      const backup = await f.backups.create();
      const generation = new GenerationService(f.projects, f.store, f.gate);
      const baseline = await generation.readWorkspace(f.first.project.id);
      const shot = newShot('pending-reference-shot', '尚在暂存区的素材', {
        x: 1,
        y: 2,
      });
      shot.nodes.push({
        id: 'pending-node',
        type: 'asset',
        assetId: f.job.id,
        position: { x: 3, y: 4 },
      });
      const workspace = { ...baseline, shots: [shot] };
      let draftFile: string | null = null;
      if (location === 'workspace')
        await generation.saveWorkspace(f.first.project.id, workspace, baseline);
      else {
        const drafts = new WorkspaceDraftService(f.app);
        try {
          await drafts.protect(f.first.project, {
            sessionId: 'pending-ref',
            seq: 1,
            baseline,
            workspace,
          });
          draftFile = join(
            f.app,
            'workspace-drafts',
            `${f.first.project.id}.pending-ref.json`,
          );
        } finally {
          await drafts.close();
        }
      }
      const projectFile = join(
        f.root,
        f.first.project.folder,
        'project.sqlite',
      );
      const projectBefore = await backupHash(projectFile);
      const draftBefore = draftFile ? await backupHash(draftFile) : null;
      await f.close();
      const before = await readFile(f.database);
      await assert.rejects(
        new AppBackupRecovery(f.app).preview(backup.id),
        /未保存|暂存/,
      );
      assert.deepEqual(await readFile(f.database), before);
      assert.equal(await backupHash(projectFile), projectBefore);
      if (draftFile) assert.equal(await backupHash(draftFile), draftBefore);
      assert.deepEqual(await readFile(f.staging.path(f.job.id)), f.bytes);
    });
  }
});

test('a current project with live uncheckpointed WAL is retained and refused by offline index recovery', async (t) => {
  const f = await appBackupFixture(t);
  const backup = await f.backups.create();
  await f.close();
  const file = join(f.root, f.first.project.folder, 'project.sqlite');
  const writer = new DatabaseSync(file);
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    writer
      .prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)')
      .run('uncheckpointed-user-data', '{"保留":true}');
    const mainBefore = await readFile(file);
    const walBefore = await readFile(`${file}-wal`);
    assert.ok(walBefore.length);
    await assert.rejects(new AppBackupRecovery(f.app).preview(backup.id));
    assert.deepEqual(await readFile(file), mainBefore);
    assert.deepEqual(await readFile(`${file}-wal`), walBefore);
  } finally {
    writer.close();
  }
});

test('unsupported backup manifests and malformed retained reports remain visible and unchanged', async (t) => {
  const f = await appBackupFixture(t);
  const backup = await f.backups.create();
  const manifest = join(f.app, 'app-backups', backup.id, 'manifest.json');
  const future = {
    ...JSON.parse(await readFile(manifest, 'utf8')),
    version: 999,
  };
  await writeFile(manifest, JSON.stringify(future));
  const report = {
    backupId: backup.id,
    retainedDirectory: f.root,
    retainedJobCount: 'invalid',
  };
  f.store.set('appBackupRecovery', report);
  const found = await f.backups.list();
  assert.equal(found.recovery, null);
  assert.ok(found.issues.some((issue) => issue.file === backup.id));
  assert.ok(found.issues.some((issue) => issue.file === 'appBackupRecovery'));
  assert.deepEqual(f.store.get('appBackupRecovery'), report);
  assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), future);
  await f.close();
  await assert.rejects(
    new AppBackupRecovery(f.app).preview(backup.id),
    /版本|清单/,
  );
  assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')), future);
});
