import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { AppBackupRecovery } from '../src/main/backups/app-backup-recovery';
import { ANCHOR_FILE } from '../src/main/backups/backup-files';
import { readApplication } from '../src/main/relocation/relocation-database';
import { settleRelocation } from '../src/main/relocation/relocation-settlement';
import { RootRelocationService } from '../src/main/relocation/root-relocation-service';
import {
  RELOCATION_FILE,
  type RelocationIntent,
} from '../src/main/relocation/root-relocation-types';
import { openDatabase } from '../src/main/storage/database';
import { Library } from '../src/main/storage/library';
import { requireCleanProfile } from '../src/main/storage/startup-checks';
import { appBackupFixture } from './fixtures/app-backup';

async function fixture(t: TestContext) {
  const f = await appBackupFixture(t);
  await f.close();
  const moved = join(f.base, 'moved root');
  await fs.rename(f.root, moved);
  const service = new RootRelocationService(f.app);
  t.after(() => service.close());
  return { ...f, moved, service };
}
type Mode =
  | 'before-archive'
  | 'before-publish'
  | 'before-anchor'
  | 'before-intent-removal';
async function interrupted(t: TestContext, mode: Mode) {
  const f = await fixture(t);
  const original = await fs.readFile(f.database);
  const ticket = await f.service.preview(f.moved);
  const rename = fs.rename;
  const link = fs.link;
  const unlink = fs.unlink;
  let hits = 0;
  const fail = () => {
    hits++;
    throw new Error(`fixture interruption ${mode}`);
  };
  const mocks = [
    t.mock.method(
      fs,
      'rename',
      async (...args: Parameters<typeof fs.rename>) => {
        if (
          (mode === 'before-archive' && String(args[0]) === f.database) ||
          (mode === 'before-anchor' &&
            String(args[1]) === join(f.app, ANCHOR_FILE))
        )
          fail();
        return rename(...args);
      },
    ),
    t.mock.method(fs, 'link', async (...args: Parameters<typeof fs.link>) => {
      if (mode === 'before-publish' && String(args[1]) === f.database) fail();
      return link(...args);
    }),
    t.mock.method(
      fs,
      'unlink',
      async (...args: Parameters<typeof fs.unlink>) => {
        if (
          mode === 'before-intent-removal' &&
          String(args[0]) === join(f.app, RELOCATION_FILE)
        )
          fail();
        return unlink(...args);
      },
    ),
  ];
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      f.service.confirm(ticket.token),
      /fixture interruption/,
    );
  } finally {
    for (const mock of mocks) mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(hits, 1);
  const intentFile = join(f.app, RELOCATION_FILE);
  const intent = JSON.parse(
    await fs.readFile(intentFile, 'utf8'),
  ) as RelocationIntent;
  return { ...f, original, intent, intentFile };
}

test('all four durable publication states converge without losing original rows, archive or ready bytes', async (t) => {
  for (const mode of [
    'before-archive',
    'before-publish',
    'before-anchor',
    'before-intent-removal',
  ] as const)
    await t.test(mode, async (t) => {
      const f = await interrupted(t, mode);
      const beforeJobs =
        mode === 'before-archive'
          ? (await readApplication(f.database)).data.saves
          : (await readApplication(join(f.intent.retained.path, 'app.sqlite')))
              .data.saves;
      await new RootRelocationService(f.app).resumePending();
      assert.deepEqual(
        await fs.readFile(join(f.intent.retained.path, 'app.sqlite')),
        f.original,
      );
      assert.deepEqual(
        (await readApplication(f.database)).data.saves,
        beforeJobs,
      );
      assert.deepEqual(await fs.readFile(f.staging.path(f.job.id)), f.bytes);
      await assert.rejects(fs.stat(f.intentFile), { code: 'ENOENT' });
      const current = await fs.readFile(f.database);
      await new RootRelocationService(f.app).resumePending();
      assert.deepEqual(await fs.readFile(f.database), current);
      for (let i = 0; i < 2; i++) {
        const library = await Library.open(f.app, f.root);
        assert.equal(library.store.root, f.moved);
        await library.saves.idle();
        await library.close();
      }
      await assert.rejects(fs.stat(f.root), { code: 'ENOENT' });
    });
});

test('after an interruption, changed files or a third routing generation stop resume and preserve the full scene', async (t) => {
  for (const mode of [
    'live-replacement',
    'candidate',
    'project',
    'anchor',
    'root-reappears',
    'restore-intent',
  ] as const)
    await t.test(mode, async (t) => {
      const f = await interrupted(t, 'before-publish');
      const candidate = join(f.intent.retained.path, 'new-app.sqlite');
      if (mode === 'live-replacement')
        await fs.writeFile(f.database, 'user replacement', { flag: 'wx' });
      if (mode === 'candidate')
        await fs.writeFile(candidate, 'changed candidate');
      if (mode === 'project') {
        const db = openDatabase(
          join(f.moved, f.first.project.id, 'project.sqlite'),
        );
        db.prepare("UPDATE metadata SET value=? WHERE key='project'").run(
          JSON.stringify({ ...f.first.project, name: 'external change' }),
        );
        db.close();
      }
      if (mode === 'anchor')
        await fs.writeFile(
          join(f.app, ANCHOR_FILE),
          JSON.stringify({ ...f.intent.anchor, generation: randomUUID() }),
        );
      if (mode === 'root-reappears') await fs.mkdir(f.root);
      if (mode === 'restore-intent')
        await fs.writeFile(join(f.app, 'app-backup-restore.json'), '{}');
      const paths = [
        f.intentFile,
        candidate,
        join(f.intent.retained.path, 'app.sqlite'),
        join(f.app, ANCHOR_FILE),
        f.staging.path(f.job.id),
      ];
      const before = await Promise.all(paths.map((path) => fs.readFile(path)));
      await assert.rejects(new RootRelocationService(f.app).resumePending());
      await assert.rejects(Library.open(f.app, f.root));
      for (const [i, path] of paths.entries())
        assert.deepEqual(await fs.readFile(path), before[i]);
      if (mode === 'live-replacement')
        assert.equal(await fs.readFile(f.database, 'utf8'), 'user replacement');
      else await assert.rejects(fs.stat(f.database), { code: 'ENOENT' });
    });
});

test('a new anchor with the old live database is rejected; old generations cannot replay retained tasks', async (t) => {
  const f = await interrupted(t, 'before-intent-removal');
  await fs.unlink(f.database);
  await fs.copyFile(join(f.intent.retained.path, 'app.sqlite'), f.database);
  const before = await fs.readFile(f.database);
  await assert.rejects(
    new RootRelocationService(f.app).resumePending(),
    /代际/,
  );
  await assert.rejects(Library.open(f.app, f.root));
  assert.deepEqual(await fs.readFile(f.database), before);
  assert.deepEqual(await fs.readFile(f.staging.path(f.job.id)), f.bytes);
});

test('cancel and close after explicit confirmation wait for publication instead of withdrawing consent halfway', async (t) => {
  const f = await fixture(t);
  const ticket = await f.service.preview(f.moved);
  const link = fs.link;
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = t.mock.method(
    fs,
    'link',
    async (...args: Parameters<typeof fs.link>) => {
      if (String(args[1]) === f.database) {
        entered();
        await paused;
      }
      return link(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    const confirming = f.service.confirm(ticket.token);
    await enteredPromise;
    f.service.cancel();
    let closed = false;
    const closing = f.service.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    release();
    assert.equal((await confirming).root, f.moved);
    await closing;
    assert.equal(closed, true);
  } finally {
    release();
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  await assert.rejects(fs.stat(join(f.app, RELOCATION_FILE)), {
    code: 'ENOENT',
  });
});

test('relocation traces prevent an empty replacement profile, while a truly absent profile is a read-only no-op', async (t) => {
  const base = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'afflatus-relocation-empty-')),
  );
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const userData = join(base, 'missing');
  const root = join(base, 'root');
  const service = new RootRelocationService(userData);
  assert.equal(await service.available(), false);
  await service.resumePending();
  await assert.rejects(fs.stat(userData), { code: 'ENOENT' });
  await fs.mkdir(userData);
  await fs.writeFile(join(userData, RELOCATION_FILE), '{}');
  await assert.rejects(requireCleanProfile(userData, root));
  await assert.rejects(new AppBackupRecovery(userData).resumePending());
});

test('a live database replacement immediately after anchor publication preserves the candidate and intent', async (t) => {
  const f = await fixture(t);
  const ticket = await f.service.preview(f.moved);
  const rename = fs.rename;
  let replaced = false;
  const replacement = Buffer.from(
    'external replacement after new anchor publication',
  );
  const parked = join(f.app, 'externally-moved-app.sqlite');
  const mock = t.mock.method(
    fs,
    'rename',
    async (...args: Parameters<typeof fs.rename>) => {
      const result = await rename(...args);
      if (!replaced && String(args[1]) === join(f.app, ANCHOR_FILE)) {
        replaced = true;
        await rename(f.database, parked);
        await fs.writeFile(f.database, replacement, { flag: 'wx' });
      }
      return result;
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.service.confirm(ticket.token), /发布位置|变化/);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(replaced, true);
  const intentPath = join(f.app, RELOCATION_FILE);
  const intentBytes = await fs.readFile(intentPath);
  const intent = JSON.parse(intentBytes.toString()) as RelocationIntent;
  const candidatePath = join(intent.retained.path, 'new-app.sqlite');
  const candidate = await fs.readFile(candidatePath);
  assert.deepEqual(await fs.readFile(f.database), replacement);
  await assert.rejects(new RootRelocationService(f.app).resumePending());
  assert.deepEqual(await fs.readFile(candidatePath), candidate);
  assert.deepEqual(await fs.readFile(intentPath), intentBytes);
  await fs.unlink(f.database);
  await fs.rename(parked, f.database);
  await new RootRelocationService(f.app).resumePending();
  assert.equal(
    (await readApplication(f.database)).data.settings.find(
      (row) => row.key === 'root',
    )?.value,
    f.moved,
  );
});

test('the final async source proof cannot clear an intent after its published file was moved away', async (t) => {
  const f = await interrupted(t, 'before-intent-removal');
  const intentBytes = await fs.readFile(f.intentFile);
  const before = await fs.readFile(f.database);
  const parked = join(f.app, 'parked.sqlite');
  const lstat = fs.lstat;
  const open = fs.open;
  let hit = false;
  let sourceDescriptorClosed = false;
  // The post-publication settlement reads the source last. Move it after the
  // asynchronous metadata result, so only the final synchronous guard can see it.
  const openMock = t.mock.method(
    fs,
    'open',
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]) === f.database) {
        const close = handle.close.bind(handle);
        handle.close = async () => {
          await close();
          sourceDescriptorClosed = true;
        };
      }
      return handle;
    },
  );
  const mock = t.mock.method(
    fs,
    'lstat',
    async (...args: Parameters<typeof fs.lstat>) => {
      const value = await lstat(...args);
      if (String(args[0]) === f.database && sourceDescriptorClosed && !hit) {
        hit = true;
        await fs.rename(f.database, parked);
      }
      return value;
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(settleRelocation(f.app, f.intent));
  } finally {
    openMock.mock.restore();
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(hit, true);
  assert.deepEqual(await fs.readFile(parked), before);
  assert.deepEqual(await fs.readFile(f.intentFile), intentBytes);
});
