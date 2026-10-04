import assert from 'node:assert/strict';
import fs, {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import { withProject } from '../src/main/projects/project-database';
import { sameFileState } from '../src/main/saving/file-state';
import {
  type SavedResultVerifier,
  savedResultVerifier,
} from '../src/main/saving/saved-result-verifier';
import { Staging } from '../src/main/saving/staging';
import { Library } from '../src/main/storage/library';

async function fixture(t: TestContext) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-saved-result-')),
  );
  const app = join(base, 'app');
  const root = join(base, 'projects');
  let library = await Library.open(app, root);
  const project = (await library.projects.create('完整保存的素材')).project;
  const bytes = Buffer.from('saved-result cleanup must preserve unique bytes');
  const cleanup = t.mock.method(library.staging, 'remove', async () => {
    throw Object.assign(new Error('last cleanup is locked'), {
      code: 'EACCES',
    });
  });
  const received = await library.acceptResult(
    {
      projectId: project.id,
      resultKey: 'test:real-saved-result',
      name: '原视频.mp4',
      kind: 'video',
      extension: 'mp4',
    },
    Readable.from(bytes),
  );
  await library.saves.idle();
  const job = library.store.job(received.id);
  assert.equal(job.status, 'saved');
  assert.equal(cleanup.mock.callCount(), 1);
  cleanup.mock.restore();
  const snapshot = await library.projects.open(project.id);
  const asset = snapshot.assets.find((item) => item.id === job.id);
  assert.ok(asset);
  const database = await library.projects.databasePath(project.id);
  const databaseBytes = await readFile(database);
  const target = join(root, project.folder, asset.relativePath);
  const ready = library.staging.path(job.id);
  assert.deepEqual(await readFile(ready), bytes);
  t.after(async () => {
    await library.close();
    await rm(base, { recursive: true, force: true });
  });
  return {
    base,
    app,
    root,
    project,
    job,
    asset,
    bytes,
    snapshot,
    database,
    databaseBytes,
    target,
    ready,
    get library() {
      return library;
    },
    async reopen() {
      await library.close();
      library = await Library.open(app, root);
      await library.saves.idle();
    },
    async cleanupWith(verifier: SavedResultVerifier) {
      const staging = new Staging(
        dirname(ready),
        library.store,
        () => {},
        undefined,
        verifier,
      );
      await staging.recover();
    },
    async retained() {
      assert.deepEqual(await readFile(ready), bytes);
      assert.deepEqual(library.store.job(job.id), job);
    },
  };
}

test('ordinary startup preserves a saved ready when its registered destination is missing, without replaying the job', async (t) => {
  const f = await fixture(t);
  await unlink(f.target);
  for (let index = 0; index < 2; index++) {
    await f.reopen();
    await f.retained();
    await assert.rejects(lstat(f.target), { code: 'ENOENT' });
    assert.deepEqual(await readFile(f.database), f.databaseBytes);
    assert.deepEqual(await f.library.projects.open(f.project.id), f.snapshot);
  }
});

test('ordinary startup preserves saved ready and same-sized wrong destination bytes', async (t) => {
  const f = await fixture(t);
  const replacement = Buffer.alloc(f.bytes.length, 7);
  await writeFile(f.target, replacement);
  for (let index = 0; index < 2; index++) {
    await f.reopen();
    await f.retained();
    assert.deepEqual(await readFile(f.target), replacement);
    assert.deepEqual(await readFile(f.database), f.databaseBytes);
  }
});

test('wrong project identity cannot authorize deletion of a saved ready', async (t) => {
  const f = await fixture(t);
  const other = (await f.library.projects.create('另一项目')).project;
  const otherDatabase = await f.library.projects.databasePath(other.id);
  const otherBytes = await readFile(otherDatabase);
  await copyFile(otherDatabase, f.database);
  await f.reopen();
  await f.retained();
  await assert.rejects(f.library.projects.open(f.project.id), /索引不匹配/);
  assert.deepEqual(await readFile(otherDatabase), otherBytes);
  assert.deepEqual(await readFile(f.database), otherBytes);
  assert.deepEqual(await readFile(f.target), f.bytes);
});

test('ordinary startup cleans only a redundant ready with a complete current target', async (t) => {
  const f = await fixture(t);
  await f.reopen();
  await assert.rejects(lstat(f.ready), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.target), f.bytes);
  assert.deepEqual(await readFile(f.database), f.databaseBytes);
  assert.deepEqual(f.library.store.job(f.job.id), f.job);
});

test('saved jobs without an actual ready never inspect their project or media during recovery', async (t) => {
  const f = await fixture(t);
  await unlink(f.ready);
  const inspect = t.mock.method(f.library.projects, 'open', async () => {
    throw new Error('A historical saved job must not scan its media');
  });
  await f.library.staging.recover();
  assert.equal(inspect.mock.callCount(), 0);
  assert.deepEqual(f.library.store.job(f.job.id), f.job);
});

test('plain staging without project verification defaults to retaining a saved ready', async (t) => {
  const f = await fixture(t);
  const staging = new Staging(dirname(f.ready), f.library.store, () => {});
  await staging.recover();
  await f.retained();
});

test('explicit health restoration preserves the ready source; a later ordinary startup can clean it', async (t) => {
  const f = await fixture(t);
  await unlink(f.target);
  await f.reopen();
  await f.retained();
  const report = await f.library.health.restore(
    f.project.id,
    f.job.id,
    f.ready,
  );
  assert.deepEqual(report.issues, []);
  assert.deepEqual(await readFile(f.target), f.bytes);
  await f.retained();
  assert.deepEqual(await readFile(f.database), f.databaseBytes);
  await f.reopen();
  await assert.rejects(lstat(f.ready), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.target), f.bytes);
  assert.deepEqual(f.library.store.job(f.job.id), f.job);
});

test('a target replaced after its full verification cannot authorize ready cleanup', async (t) => {
  const f = await fixture(t);
  const verify = savedResultVerifier(f.library.store, f.library.projects);
  const held = join(f.base, 'held-original');
  await f.cleanupWith(async (job, signal) => {
    const recheck = await verify(job, signal);
    await rename(f.target, held);
    await writeFile(f.target, f.bytes);
    return recheck;
  });
  await f.retained();
  assert.deepEqual(await readFile(held), f.bytes);
  assert.deepEqual(await readFile(f.target), f.bytes);
});

test('same-inode target edits with restored mtime are caught by ctimeNs', async (t) => {
  const f = await fixture(t);
  await utimes(f.target, 1_000_000, 1_000_000);
  const before = await lstat(f.target, { bigint: true });
  const replacement = Buffer.alloc(f.bytes.length, 8);
  const verify = savedResultVerifier(f.library.store, f.library.projects);
  await f.cleanupWith(async (job, signal) => {
    const recheck = await verify(job, signal);
    await writeFile(f.target, replacement);
    await utimes(f.target, 1_000_000, 1_000_000);
    return recheck;
  });
  const after = await lstat(f.target, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.notEqual(after.ctimeNs, before.ctimeNs);
  await f.retained();
  assert.deepEqual(await readFile(f.target), replacement);
});

test('a changed saved acknowledgement is not consumed as stale cleanup authorization', async (t) => {
  const f = await fixture(t);
  const verify = savedResultVerifier(f.library.store, f.library.projects);
  const changed = { ...f.job, resultKey: 'different:current-result' };
  await f.cleanupWith(async (job, signal) => {
    const recheck = await verify(job, signal);
    f.library.store.putJob(changed);
    return recheck;
  });
  assert.deepEqual(await readFile(f.ready), f.bytes);
  assert.deepEqual(f.library.store.job(f.job.id), changed);
});

test('asset registration changed after verification preserves the ready and never rewrites the new record', async (t) => {
  const f = await fixture(t);
  const verify = savedResultVerifier(f.library.store, f.library.projects);
  const changed = { ...f.asset, sha256: 'a'.repeat(64) };
  await f.cleanupWith(async (job, signal) => {
    const recheck = await verify(job, signal);
    withProject(
      f.database,
      true,
      (db) => {
        db.prepare('UPDATE assets SET payload = ? WHERE id = ?').run(
          JSON.stringify(changed),
          f.asset.id,
        );
      },
      f.project,
    );
    return recheck;
  });
  await f.retained();
  assert.deepEqual(
    (await f.library.projects.open(f.project.id)).assets[0],
    changed,
  );
});

test('a route change after target verification preserves saved staging', async (t) => {
  const f = await fixture(t);
  const nextRoot = join(f.base, 'other-root');
  await mkdir(nextRoot);
  const verify = savedResultVerifier(f.library.store, f.library.projects);
  await f.cleanupWith(async (job, signal) => {
    const recheck = await verify(job, signal);
    f.library.store.set('root', nextRoot);
    return recheck;
  });
  await f.retained();
  assert.deepEqual(await readFile(f.target), f.bytes);
});

test('a ready replaced while the verified-target proof is checked is preserved', async (t) => {
  const f = await fixture(t);
  const verify = savedResultVerifier(f.library.store, f.library.projects);
  const held = join(f.base, 'held-ready');
  const replacement = Buffer.from('this belongs to a different file');
  await f.cleanupWith(async (job, signal) => {
    const proof = await verify(job, signal);
    return {
      ...proof,
      async recheck() {
        await proof.recheck();
        await rename(f.ready, held);
        await writeFile(f.ready, replacement);
      },
    };
  });
  assert.deepEqual(await readFile(f.ready), replacement);
  assert.deepEqual(await readFile(held), f.bytes);
  assert.deepEqual(f.library.store.job(f.job.id), f.job);
});

test('a staging directory replaced by a link preserves both the original and external same-content ready', async (t) => {
  const f = await fixture(t);
  const directory = dirname(f.ready);
  const held = join(f.base, 'held-staging');
  const outside = join(f.base, 'external-staging');
  await mkdir(outside);
  const external = join(outside, `${f.job.id}.ready`);
  await writeFile(external, f.bytes);
  await rename(directory, held);
  await symlink(
    outside,
    directory,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await f.library.staging.recover();
  assert.deepEqual(await readFile(external), f.bytes);
  assert.deepEqual(await readFile(join(held, `${f.job.id}.ready`)), f.bytes);
  assert.deepEqual(f.library.store.job(f.job.id), f.job);
});

test('a staging directory replaced after verification preserves even a hard-linked identical ready', async (t) => {
  const f = await fixture(t);
  const directory = dirname(f.ready);
  const held = join(f.base, 'held-staging');
  const replacement = join(f.base, 'replacement-staging');
  await mkdir(replacement);
  // A hard link makes final-file identity insufficient; only the directory
  // binding proves that the deletion still addresses the checked location.
  await link(f.ready, join(replacement, `${f.job.id}.ready`));
  const verify = savedResultVerifier(f.library.store, f.library.projects);
  await f.cleanupWith(async (job, signal) => {
    const proof = await verify(job, signal);
    return {
      ...proof,
      async recheck() {
        await proof.recheck();
        await rename(directory, held);
        await rename(replacement, directory);
      },
    };
  });
  await f.retained();
  assert.deepEqual(await readFile(join(held, `${f.job.id}.ready`)), f.bytes);
});

for (const subject of ['target', 'ready'] as const) {
  test(`cleanup binds the hashed ${subject} descriptor even when a parent directory switches away and back`, async (t) => {
    const f = await fixture(t);
    const file = f[subject];
    const directory = dirname(file);
    const held = join(f.base, 'held-parent');
    const alternate = join(f.base, 'alternate-parent');
    const different = Buffer.alloc(f.bytes.length, 9);
    await writeFile(file, different);
    await mkdir(alternate);
    await writeFile(join(alternate, basename(file)), f.bytes);
    const before = await lstat(file, { bigint: true });
    const originalOpen = fs.open;
    let switched = false;
    const replace = t.mock.method(
      fs,
      'open',
      async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]) !== file) return originalOpen(...args);
        replace.mock.restore();
        syncBuiltinESMExports();
        await rename(directory, held);
        await rename(alternate, directory);
        const handle = await originalOpen(...args);
        await rename(directory, alternate);
        await rename(held, directory);
        switched = true;
        return handle;
      },
    );
    syncBuiltinESMExports();
    try {
      await f.library.staging.recover();
    } finally {
      replace.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(switched, true);
    // Parent renames leave the original file's six fields unchanged. This
    // regression therefore cannot pass merely due to an outer ctime check.
    assert.equal(
      sameFileState(before, await lstat(file, { bigint: true })),
      true,
    );
    assert.deepEqual(await readFile(file), different);
    assert.deepEqual(
      await readFile(f.ready),
      subject === 'ready' ? different : f.bytes,
    );
    assert.deepEqual(f.library.store.job(f.job.id), f.job);
    assert.deepEqual(await readFile(f.database), f.databaseBytes);
  });
}

test('a target lost during the final asynchronous ready check is caught before unlink', async (t) => {
  const f = await fixture(t);
  const verify = savedResultVerifier(f.library.store, f.library.projects);
  const originalLstat = fs.lstat;
  let proofComplete = false;
  let targetRemoved = false;
  const replace = t.mock.method(
    fs,
    'lstat',
    async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === f.ready && proofComplete) {
        replace.mock.restore();
        syncBuiltinESMExports();
        await unlink(f.target);
        targetRemoved = true;
      }
      return originalLstat(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    await f.cleanupWith(async (job, signal) => {
      const proof = await verify(job, signal);
      return {
        ...proof,
        async recheck() {
          await proof.recheck();
          proofComplete = true;
        },
      };
    });
  } finally {
    replace.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(targetRemoved, true);
  await f.retained();
  await assert.rejects(lstat(f.target), { code: 'ENOENT' });
});
