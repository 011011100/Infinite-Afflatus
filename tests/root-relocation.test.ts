import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { AppBackupRecovery } from '../src/main/backups/app-backup-recovery';
import { ANCHOR_FILE, readJson } from '../src/main/backups/backup-files';
import { readApplication } from '../src/main/relocation/relocation-database';
import { RootRelocationService } from '../src/main/relocation/root-relocation-service';
import { RELOCATION_FILE } from '../src/main/relocation/root-relocation-types';
import { openDatabase } from '../src/main/storage/database';
import { Library } from '../src/main/storage/library';
import { appBackupFixture } from './fixtures/app-backup';

async function fixture(t: TestContext) {
  const f = await appBackupFixture(t);
  await f.close();
  const moved = join(f.base, '改名后的原项目目录 🎬');
  await fs.rename(f.root, moved);
  const service = new RootRelocationService(f.app);
  t.after(() => service.close());
  return { ...f, moved, service };
}

test('same-directory relocation preserves raw rows and ready bytes; only normal startup resumes the queue', async (t) => {
  const f = await fixture(t);
  const original = await fs.readFile(f.database);
  const rows = (await readApplication(f.database)).data;
  const media = await fs.readFile(f.staging.path(f.job.id));
  const before = await fs.readdir(f.app);
  assert.equal(await f.service.available(), true);
  const preview = await f.service.preview(f.moved);
  assert.equal(preview.pendingSaveCount, 1);
  assert.deepEqual(
    preview.projects.map((p) => p.id),
    rows.projects.map((r) => r.id),
  );
  assert.deepEqual(await fs.readdir(f.app), before, 'preview is read only');
  f.service.cancel();
  await assert.rejects(f.service.confirm(preview.token));
  assert.deepEqual(await fs.readFile(f.database), original);
  const result = await f.service.confirm(
    (await f.service.preview(f.moved)).token,
  );
  assert.equal(result.root, f.moved);
  assert.deepEqual(
    await fs.readFile(join(result.retainedDirectory, 'app.sqlite')),
    original,
  );
  const current = (await readApplication(f.database)).data;
  assert.deepEqual(current.projects, rows.projects);
  assert.deepEqual(current.saves, rows.saves);
  assert.deepEqual(
    current.settings.filter(
      (r) => !['root', 'appBackupGeneration'].includes(r.key ?? ''),
    ),
    rows.settings.filter(
      (r) => !['root', 'appBackupGeneration'].includes(r.key ?? ''),
    ),
  );
  assert.deepEqual(await fs.readFile(f.staging.path(f.job.id)), media);
  assert.equal(await f.service.available(), false);
  await assert.rejects(f.service.confirm(preview.token));
  for (let i = 0; i < 2; i++) {
    const library = await Library.open(f.app, f.root);
    assert.equal(library.store.root, f.moved);
    await library.saves.idle();
    assert.equal(library.store.job(f.job.id)?.status, 'saved');
    await library.close();
  }
  await assert.rejects(fs.stat(f.root), { code: 'ENOENT' });
});

test('existing old root, copied directory, symlink and incorrect indexed project all refuse without changing app bytes', async (t) => {
  for (const mode of ['old-root', 'copy', 'symlink', 'wrong-project'] as const)
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      const original = await fs.readFile(f.database);
      let candidate = f.moved;
      if (mode === 'old-root') await fs.mkdir(f.root);
      if (mode === 'copy') {
        candidate = join(f.base, 'copy');
        await fs.cp(f.moved, candidate, { recursive: true });
      }
      if (mode === 'symlink') {
        candidate = join(f.base, 'link');
        await fs.symlink(
          f.moved,
          candidate,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      }
      if (mode === 'wrong-project') {
        const file = join(f.moved, f.first.project.id, 'project.sqlite');
        const db = openDatabase(file);
        const wrong = { ...f.first.project, id: randomUUID() };
        db.prepare("UPDATE metadata SET value=? WHERE key='project'").run(
          JSON.stringify(wrong),
        );
        db.close();
      }
      await assert.rejects(f.service.preview(candidate));
      assert.deepEqual(await fs.readFile(f.database), original);
      await assert.rejects(fs.stat(join(f.app, RELOCATION_FILE)), {
        code: 'ENOENT',
      });
    });
});

test('pending migration or root-bound cleanup authorization prevents relocation; terminal journal is preserved', async (t) => {
  for (const [key, value] of [
    ['migration', { status: { phase: 'cleaning' } }],
    ['project-package-work', [{ root: '/old-owned-path' }]],
    ['asset-repair-work', [{ parent: { path: '/old-owned-path' } }]],
  ] as const)
    await t.test(key, async (t) => {
      const f = await appBackupFixture(t);
      f.store.set(key, value);
      await f.close();
      const moved = join(f.base, 'moved');
      await fs.rename(f.root, moved);
      const service = new RootRelocationService(f.app);
      assert.equal(await service.available(), false);
      await assert.rejects(service.preview(moved));
      await service.close();
    });
  await t.test('terminal', async (t) => {
    const f = await appBackupFixture(t);
    const terminal = {
      status: {
        phase: 'failed',
        source: f.root,
        target: '/unchanged-old-target',
      },
      files: [{ relativePath: 'retain-this-authorization-exactly' }],
    };
    f.store.set('migration', terminal);
    await f.close();
    const moved = join(f.base, 'moved');
    await fs.rename(f.root, moved);
    const service = new RootRelocationService(f.app);
    await service.confirm((await service.preview(moved)).token);
    const data = (await readApplication(f.database)).data;
    assert.equal(
      data.settings.find((r) => r.key === 'migration')?.value,
      JSON.stringify(terminal),
    );
    await service.close();
  });
});

test('preview expires and changes to database, project or generation invalidate confirmation', async (t) => {
  for (const mode of [
    'expiry',
    'app',
    'project',
    'anchor',
    'root-reappears',
  ] as const)
    await t.test(mode, async (t) => {
      const f = await fixture(t);
      const preview = await f.service.preview(f.moved);
      if (mode === 'expiry')
        t.mock.method(Date, 'now', () => Date.parse(preview.expiresAt));
      if (mode === 'app') {
        const db = openDatabase(f.database);
        db.prepare(
          "UPDATE settings SET value=? WHERE key='fixturePreference'",
        ).run('{"changed":true}');
        db.close();
      }
      if (mode === 'project') {
        const db = openDatabase(
          join(f.moved, f.first.project.id, 'project.sqlite'),
        );
        db.prepare("UPDATE metadata SET value=? WHERE key='project'").run(
          JSON.stringify({ ...f.first.project, name: 'changed' }),
        );
        db.close();
      }
      if (mode === 'anchor') {
        const path = join(f.app, ANCHOR_FILE);
        await fs.writeFile(
          path,
          JSON.stringify({
            ...((await readJson(path)) as object),
            generation: randomUUID(),
          }),
        );
      }
      if (mode === 'root-reappears') await fs.mkdir(f.root);
      const original = await fs.readFile(f.database);
      await assert.rejects(f.service.confirm(preview.token));
      assert.deepEqual(await fs.readFile(f.database), original);
      await assert.rejects(fs.stat(join(f.app, RELOCATION_FILE)), {
        code: 'ENOENT',
      });
    });
});

test('preview cancellation and close invalidate late checks without publishing an intent', async (t) => {
  const f = await fixture(t);
  const pending = f.service.preview(f.moved);
  f.service.cancel();
  await assert.rejects(pending, /取消/);
  assert.equal(await f.service.available(), true);
  const pending2 = f.service.preview(f.moved);
  await f.service.close();
  await assert.rejects(pending2);
  assert.equal(await f.service.available(), false);
  await assert.rejects(fs.stat(join(f.app, RELOCATION_FILE)), {
    code: 'ENOENT',
  });
});

test('sidecars and WAL databases are refused without reading uncheckpointed state or modifying source files', async (t) => {
  for (const target of ['application', 'project'] as const)
    await t.test(target, async (t) => {
      const f = await fixture(t);
      const file =
        target === 'application'
          ? f.database
          : join(f.moved, f.first.project.id, 'project.sqlite');
      await fs.writeFile(`${file}-wal`, 'must never be consumed');
      const before = await fs.readFile(file);
      await assert.rejects(f.service.preview(f.moved), /日志/);
      assert.deepEqual(await fs.readFile(file), before);
      assert.equal(
        await fs.readFile(`${file}-wal`, 'utf8'),
        'must never be consumed',
      );
    });
});

test('relocation and backup restore intents are mutually exclusive', async (t) => {
  const f = await fixture(t);
  const restore = join(f.app, 'app-backup-restore.json');
  await fs.writeFile(restore, '{}');
  assert.equal(await f.service.available(), false);
  await assert.rejects(f.service.preview(f.moved), /恢复尚未结束/);
  await fs.writeFile(join(f.app, RELOCATION_FILE), '{}');
  await assert.rejects(new AppBackupRecovery(f.app).resumePending());
  await assert.rejects(Library.open(f.app, f.root));
});

test('descriptor-bound database hashes reject a parent-directory ABA that outer path stats cannot detect', async (t) => {
  const f = await fixture(t);
  const project = join(f.moved, f.first.project.id);
  const parked = join(f.moved, 'parked');
  const substitute = join(f.moved, 'substitute');
  await fs.cp(project, substitute, { recursive: true });
  const file = join(project, 'project.sqlite');
  const before = await fs.stat(file, { bigint: true });
  const originalOpen = fs.open;
  let injected = false;
  const mock = t.mock.method(
    fs,
    'open',
    async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === file && !injected) {
        injected = true;
        await fs.rename(project, parked);
        await fs.rename(substitute, project);
        const handle = await originalOpen(...args);
        await fs.rename(project, substitute);
        await fs.rename(parked, project);
        return handle;
      }
      return originalOpen(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.service.preview(f.moved), /变化/);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  const after = await fs.stat(file, { bigint: true });
  for (const key of [
    'dev',
    'ino',
    'size',
    'mtimeNs',
    'ctimeNs',
    'birthtimeNs',
  ] as const)
    assert.equal(after[key], before[key]);
});
