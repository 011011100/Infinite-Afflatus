import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import fs, {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import { STAGING_CANCELLED, Staging } from '../src/main/saving/staging';
import { StagingCleanupService } from '../src/main/saving/staging-cleanup-service';
import {
  identity,
  partFingerprint,
} from '../src/main/saving/staging-ownership';
import { AppStore } from '../src/main/storage/app-store';
import type { SaveJob } from '../src/shared/models';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext, quota?: number) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-part-cleanup-')),
  );
  const directory = join(base, 'staging');
  await mkdir(directory);
  const store = new AppStore(join(base, 'app.sqlite'), join(base, 'projects'));
  const projectId = randomUUID();
  store.putProject({
    id: projectId,
    name: '原项目',
    folder: projectId,
    updatedAt: new Date().toISOString(),
  });
  const staging = new Staging(directory, store, () => {}, quota);
  const cleanup = new StagingCleanupService(staging, store, () => {});
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await cleanup.close();
    await staging.idle();
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  const result = (key: string, local = true) => ({
    projectId,
    resultKey: local ? `reference:${key}` : `cloud:${key}`,
    name: `${key}.txt`,
    kind: 'text' as const,
    usage: local ? ('reference' as const) : undefined,
    extension: 'txt',
  });
  const partial = async (
    key: string,
    bytes = Buffer.from('unfinished bytes'),
  ) => {
    const controller = new AbortController();
    const job = await staging.receive(result(key), Readable.from(bytes), {
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.bytes) controller.abort();
      },
    });
    assert.equal(job.status, 'failed');
    assert.equal(
      job.error,
      bytes.length ? STAGING_CANCELLED : '接收结果失败：生成结果为空',
    );
    return job;
  };
  return {
    base,
    directory,
    store,
    staging,
    cleanup,
    result,
    partial,
    part: (job: SaveJob) => join(directory, `${job.id}.part`),
  };
}

test('cleanup persists exact identities, removes only owned incomplete bytes and releases quota including zero-byte records', async (t) => {
  const f = await fixture(t, 12);
  const source = join(f.base, 'source.txt');
  await writeFile(source, '0123456789ab');
  const job = await f.partial('owned', await readFile(source));
  const owned = f.staging.ownership.get(job.id);
  assert.ok(owned);
  assert.deepEqual(
    owned.fileIdentity,
    identity(await lstat(f.part(job), { bigint: true })),
  );
  const secondStore = new AppStore(join(f.base, 'app.sqlite'), 'ignored');
  assert.deepEqual(
    secondStore.get('stagingPartOwnership'),
    f.store.get('stagingPartOwnership'),
  );
  secondStore.close();
  const blocked = await f.staging.receive(
    f.result('quota'),
    Readable.from('x'),
  );
  assert.match(blocked.error ?? '', /空间已达上限/);
  assert.equal((await lstat(f.part(blocked))).size, 0);
  const preview = await f.cleanup.preview();
  assert.equal(preview.files.length, 2);
  assert.equal(preview.bytes, 12);
  assert.ok(preview.token);
  const result = await f.cleanup.execute(preview.token);
  assert.deepEqual(result, { removedCount: 2, removedBytes: 12, retained: [] });
  assert.deepEqual(f.store.jobs(), []);
  assert.deepEqual(f.staging.ownership.list(), []);
  assert.equal(await readFile(source, 'utf8'), '0123456789ab');
  assert.equal(
    (
      await f.staging.receive(
        f.result('now-fits'),
        Readable.from('0123456789ab'),
      )
    ).status,
    'ready',
  );
  await assert.rejects(f.cleanup.execute(preview.token), /预览已失效/);
});

test('legacy parts, cloud jobs, complete ready results and digest-bearing interrupted results are never cleanup candidates', async (t) => {
  const f = await fixture(t);
  const legacy = await f.partial('legacy');
  const legacyOwnership = f.staging.ownership.get(legacy.id);
  assert.ok(legacyOwnership);
  f.staging.ownership.forget(legacyOwnership);
  const cloud = await f.partial('cloud');
  f.store.putJob({ ...cloud, resultKey: 'cloud:result', usage: undefined });
  const complete = await f.staging.receive(
    f.result('ready'),
    Readable.from('complete'),
  );
  f.store.putJob({ ...complete, status: 'failed' });
  const recoverable = await f.partial('digest');
  f.store.putJob({
    ...recoverable,
    sha256: createHash('sha256')
      .update(await readFile(f.part(recoverable)))
      .digest('hex'),
  });
  const corruptReady = await f.staging.receive(
    f.result('wrong-ready'),
    Readable.from('expected'),
  );
  f.store.putJob({ ...corruptReady, status: 'failed' });
  await writeFile(f.staging.path(corruptReady.id), 'changed!');
  const items = (await f.cleanup.inspect()).items;
  assert.equal(
    items.find((item) => item.jobId === complete.id)?.canRetry,
    true,
  );
  for (const job of [legacy, cloud, recoverable, corruptReady]) {
    const item = items.find((item) => item.jobId === job.id);
    assert.ok(item);
    assert.equal(item.canRetry, false);
    assert.equal(item.canCleanup, false);
  }
  assert.match(
    items.find((item) => item.jobId === legacy.id)?.reason ?? '',
    /缺少创建/,
  );
  assert.equal((await f.cleanup.preview()).token, null);
});

test('a preview is a fixed selection and a later eligible job is not added', async (t) => {
  const f = await fixture(t);
  const first = await f.partial('first');
  const preview = await f.cleanup.preview();
  const later = await f.partial('later');
  assert.ok(preview.token);
  assert.equal((await f.cleanup.execute(preview.token)).removedCount, 1);
  assert.throws(() => f.store.job(first.id), /不存在/);
  assert.equal(f.store.job(later.id).status, 'failed');
  assert.ok(await readFile(f.part(later)));
});

test('changed file content or task status invalidates the whole preview before the first unlink', async (t) => {
  const f = await fixture(t);
  const changed = await f.partial('changed');
  const unaffected = await f.partial('unaffected');
  const preview = await f.cleanup.preview();
  await writeFile(f.part(changed), 'modified in place');
  assert.ok(preview.token);
  await assert.rejects(f.cleanup.execute(preview.token), /已变化/);
  assert.ok(await readFile(f.part(unaffected)));
  assert.equal(f.store.jobs().length, 2);
  const next = await f.cleanup.preview();
  f.store.putJob({ ...unaffected, status: 'receiving' });
  assert.ok(next.token);
  await assert.rejects(f.cleanup.execute(next.token), /不是可清理/);
  assert.ok(await readFile(f.part(unaffected)));
});

test('replacement files, symbolic links and replaced staging directories are retained', async (t) => {
  const f = await fixture(t);
  const job = await f.partial('replaced');
  const preview = await f.cleanup.preview();
  await rename(f.part(job), `${f.part(job)}.original`);
  await writeFile(f.part(job), 'foreign document');
  assert.ok(preview.token);
  await assert.rejects(f.cleanup.execute(preview.token), /不匹配/);
  assert.equal(await readFile(f.part(job), 'utf8'), 'foreign document');
  await unlink(f.part(job));
  const external = join(f.base, 'external');
  await writeFile(external, 'keep external');
  await symlink(external, f.part(job));
  assert.equal((await f.cleanup.inspect()).items[0]?.canCleanup, false);
  assert.equal(await readFile(external, 'utf8'), 'keep external');
  await rename(f.directory, `${f.directory}-old`);
  await mkdir(f.directory);
  await writeFile(f.part(job), 'new directory contents');
  assert.equal((await f.cleanup.inspect()).items[0]?.canCleanup, false);
  assert.equal((await f.cleanup.preview()).token, null);
});

test('the final unlink check catches a file replaced after intent persistence', async (t) => {
  const f = await fixture(t);
  const job = await f.partial('late-replacement');
  const preview = await f.cleanup.preview();
  const originalVerify = f.staging.ownership.verifyDirectory.bind(
    f.staging.ownership,
  );
  let afterIntent = 0;
  t.mock.method(
    f.staging.ownership,
    'verifyDirectory',
    async (...[owned]: Parameters<typeof originalVerify>) => {
      await originalVerify(owned);
      if (owned.cleanup && ++afterIntent === 2) {
        await rename(f.part(job), `${f.part(job)}.original`);
        await writeFile(f.part(job), 'replacement');
      }
    },
  );
  assert.ok(preview.token);
  const result = await f.cleanup.execute(preview.token);
  assert.equal(result.removedCount, 0);
  assert.equal(result.retained.length, 1);
  assert.equal(await readFile(f.part(job), 'utf8'), 'replacement');
  await f.cleanup.recover();
  assert.equal(f.store.job(job.id).status, 'failed');
});

test('metadata failure after unlink keeps an intent that recovery finalizes without deleting any later file', async (t) => {
  const f = await fixture(t);
  const job = await f.partial('crash');
  const preview = await f.cleanup.preview();
  const fault = t.mock.method(f.store, 'deleteJob', () => {
    throw new Error('database unavailable');
  });
  assert.ok(preview.token);
  const result = await f.cleanup.execute(preview.token);
  assert.equal(result.removedCount, 1);
  assert.equal(result.removedBytes, job.size);
  assert.match(result.retained[0]?.reason ?? '', /database unavailable/);
  fault.mock.restore();
  assert.ok(f.staging.ownership.get(job.id)?.cleanup);
  await writeFile(f.part(job), 'foreign file after unlink');
  await f.cleanup.recover();
  assert.equal(
    await readFile(f.part(job), 'utf8'),
    'foreign file after unlink',
  );
  assert.equal(f.store.job(job.id).status, 'failed');
  await unlink(f.part(job));
  await f.cleanup.recover();
  assert.throws(() => f.store.job(job.id), /不存在/);
  assert.equal(f.staging.ownership.get(job.id), null);
});

test('cancel after one unlink finishes that bookkeeping and reports the remaining files retained', async (t) => {
  const f = await fixture(t);
  const first = await f.partial('first');
  const second = await f.partial('second');
  const preview = await f.cleanup.preview();
  const original = fs.unlink;
  t.mock.method(fs, 'unlink', async (...args: Parameters<typeof unlink>) => {
    await original(...args);
    f.cleanup.cancel();
  });
  syncBuiltinESMExports();
  assert.ok(preview.token);
  const result = await f.cleanup.execute(preview.token);
  assert.equal(result.removedCount, 1);
  assert.equal(result.retained.length, 1);
  assert.equal(f.store.jobs().length, 1);
  assert.ok([first.id, second.id].includes(f.store.jobs()[0]?.id ?? ''));
  assert.equal(f.staging.ownership.list().length, 1);
});

test('concurrent background inspection and user preview queue normally; queued cancel settles before intake releases', {
  timeout: 5000,
}, async (t) => {
  const f = await fixture(t);
  await f.partial('one');
  const [inspection, preview] = await Promise.all([
    f.cleanup.inspect(),
    f.cleanup.preview(),
  ]);
  assert.equal(inspection.items.length, 1);
  assert.equal(preview.files.length, 1);
  const entered = deferred();
  const release = deferred();
  const intake = f.staging.exclusive(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const pendingInspect = f.cleanup.inspect();
  const pendingPreview = f.cleanup.preview();
  const inspectRejected = assert.rejects(pendingInspect, {
    name: 'AbortError',
  });
  const previewRejected = assert.rejects(pendingPreview, {
    name: 'AbortError',
  });
  f.cleanup.cancel();
  await Promise.all([inspectRejected, previewRejected]);
  const close = f.cleanup.close();
  await close;
  release.resolve();
  await intake;
  await f.staging.idle();
  assert.equal(f.store.jobs().length, 1);
});

test('an execute preview that expires while queued cannot delete its files', async (t) => {
  const f = await fixture(t);
  const job = await f.partial('expires');
  const preview = await f.cleanup.preview();
  assert.ok(preview.token);
  const entered = deferred();
  const release = deferred();
  const blocker = f.staging.exclusive(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const executing = f.cleanup.execute(preview.token);
  const rejection = assert.rejects(executing, /预览已失效/);
  t.mock.method(Date, 'now', () => Date.parse(preview.expiresAt ?? '') + 1);
  release.resolve();
  await Promise.all([blocker, rejection]);
  assert.ok(await readFile(f.part(job)));
});

test('unknown ownership metadata remains unchanged and cannot break complete cloud publication', async (t) => {
  const f = await fixture(t);
  const unsupported = { version: 999, entries: [{ foreign: true }] };
  f.store.set('stagingPartOwnership', unsupported);
  await assert.rejects(f.cleanup.inspect(), /不受支持/);
  await assert.rejects(f.cleanup.preview(), /不受支持/);
  const cloud = await f.staging.receive(
    f.result('cloud', false),
    Readable.from('cloud bytes'),
  );
  assert.equal(cloud.status, 'ready');
  const local = await f.staging.receive(
    f.result('blocked'),
    Readable.from('not consumed'),
  );
  assert.equal(local.status, 'failed');
  assert.deepEqual(f.store.get('stagingPartOwnership'), unsupported);
  assert.equal((await lstat(f.part(local))).size, 0);
});

test('ownership compaction failure after complete publication never discards a ready ID', async (t) => {
  const f = await fixture(t);
  t.mock.method(f.staging.ownership, 'forget', () => {
    throw new Error('optional metadata fault');
  });
  const job = await f.staging.receive(
    f.result('published'),
    Readable.from('complete'),
  );
  assert.equal(job.status, 'ready');
  assert.ok(job.sha256);
  assert.ok(f.staging.ownership.get(job.id));
  f.store.putJob({ ...job, status: 'failed' });
  const item = (await f.cleanup.inspect()).items[0];
  assert.ok(item);
  assert.equal(item.canRetry, true);
  assert.equal(item.canCleanup, false);
});

test('crash recovery does not publish a replacement partial even when its bytes match the recorded digest', async (t) => {
  const f = await fixture(t);
  const job = await f.partial('receiving');
  const bytes = await readFile(f.part(job));
  f.store.putJob({
    ...job,
    status: 'receiving',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  await rename(f.part(job), `${f.part(job)}.original`);
  await writeFile(f.part(job), bytes);
  await f.staging.recover();
  assert.equal(f.store.job(job.id).status, 'failed');
  assert.deepEqual(await readFile(f.part(job)), bytes);
  await assert.rejects(lstat(f.staging.path(job.id)), { code: 'ENOENT' });
});

test('a genuine owned digest-bearing partial recovers completely without granting cleanup to its ready result', async (t) => {
  const f = await fixture(t);
  const job = await f.partial('receiving');
  const bytes = await readFile(f.part(job));
  f.store.putJob({
    ...job,
    status: 'receiving',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  await f.staging.recover();
  assert.equal(f.store.job(job.id).status, 'ready');
  assert.equal(f.staging.ownership.get(job.id), null);
  assert.deepEqual(await readFile(f.staging.path(job.id)), bytes);
  await assert.rejects(lstat(f.part(job)), { code: 'ENOENT' });
});

test('identity serialization preserves integers beyond Number precision', () => {
  const stats = {
    dev: 9007199254740993n,
    ino: 9007199254740995n,
    birthtimeNs: 1788888888123456789n,
    size: 9007199254740997n,
    mtimeNs: 1788888888123456791n,
    ctimeNs: 1788888888123456793n,
  } as BigIntStats;
  const result = partFingerprint(stats);
  assert.equal(result.dev, '9007199254740993');
  assert.equal(result.ino, '9007199254740995');
  assert.equal(result.birthtimeNs, '1788888888123456789');
  assert.equal(result.size, '9007199254740997');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('a same-inode same-length rewrite before preview is retained by the reception seal', async (t) => {
  const f = await fixture(t);
  const job = await f.partial('edited', Buffer.from('ours'));
  const before = await lstat(f.part(job), { bigint: true });
  await writeFile(f.part(job), 'user');
  const after = await lstat(f.part(job), { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  const item = (await f.cleanup.inspect()).items[0];
  assert.equal(item?.canCleanup, false);
  assert.match(item?.reason ?? '', /接收结束后已变化/);
  assert.equal((await f.cleanup.preview()).token, null);
  assert.equal(await readFile(f.part(job), 'utf8'), 'user');
});

test('a same-size rewrite before the original fd seals is caught by the hash of actual written chunks', async (t) => {
  const f = await fixture(t);
  const original = f.staging.ownership.sealIncomplete.bind(f.staging.ownership);
  t.mock.method(
    f.staging.ownership,
    'sealIncomplete',
    async (...[id, handle, size, sha]: Parameters<typeof original>) => {
      await writeFile(join(f.directory, `${id}.part`), 'user');
      await original(id, handle, size, sha);
    },
  );
  const job = await f.partial('active-rewrite', Buffer.from('ours'));
  const owned = f.staging.ownership.get(job.id);
  assert.equal(
    owned?.partialSha256,
    createHash('sha256').update('ours').digest('hex'),
  );
  assert.ok(owned?.sealedFingerprint);
  const item = (await f.cleanup.inspect()).items[0];
  assert.equal(item?.canCleanup, false);
  assert.match(item?.reason ?? '', /实际接收的字节不符/);
  assert.equal(await readFile(f.part(job), 'utf8'), 'user');
});

test('a crash before seal never acquires a cleanup proof on startup', async (t) => {
  const f = await fixture(t);
  const job = await f.partial('unsealed');
  const owned = f.staging.ownership.get(job.id);
  assert.ok(owned);
  const { sealedFingerprint: _seal, partialSha256: _sha, ...unsealed } = owned;
  f.store.set('stagingPartOwnership', { version: 1, entries: [unsealed] });
  await f.staging.recover();
  await f.cleanup.recover();
  assert.equal((await f.cleanup.inspect()).items[0]?.canCleanup, false);
  assert.equal((await f.cleanup.preview()).token, null);
  assert.deepEqual(f.staging.ownership.get(job.id), unsealed);
  assert.ok(await readFile(f.part(job)));
});

test('active hash cancellation waits for the reader handle to close and leaves its part unchanged', {
  timeout: 5000,
}, async (t) => {
  const f = await fixture(t);
  const job = await f.partial('hash-cancel');
  const closing = deferred();
  const release = deferred();
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === f.part(job)) {
      const read = handle.createReadStream.bind(handle);
      const close = handle.close.bind(handle);
      t.mock.method(
        handle,
        'createReadStream',
        (...[options]: Parameters<typeof read>) => {
          const stream = read(options);
          stream.once('data', () => f.cleanup.cancel());
          return stream;
        },
      );
      t.mock.method(handle, 'close', async () => {
        closing.resolve();
        await release.promise;
        await close();
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  let settled = false;
  const inspecting = f.cleanup.inspect();
  const rejected = assert
    .rejects(inspecting, { name: 'AbortError' })
    .then(() => {
      settled = true;
    });
  await closing.promise;
  assert.equal(settled, false);
  const closingService = f.cleanup.close();
  release.resolve();
  await Promise.all([rejected, closingService]);
  assert.equal(await readFile(f.part(job), 'utf8'), 'unfinished bytes');
  assert.equal(f.store.job(job.id).status, 'failed');
});

test('directory sync failure after unlink retains metadata until durable recovery', async (t) => {
  const f = await fixture(t);
  const job = await f.partial('fsync');
  const preview = await f.cleanup.preview();
  const originalOpen = fs.open;
  const fault = t.mock.method(
    fs,
    'open',
    async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === f.directory)
        t.mock.method(handle, 'sync', async () => {
          throw new Error('fsync denied');
        });
      return handle;
    },
  );
  syncBuiltinESMExports();
  assert.ok(preview.token);
  const result = await f.cleanup.execute(preview.token);
  assert.equal(result.removedCount, 1);
  assert.match(result.retained[0]?.reason ?? '', /fsync denied/);
  assert.ok(f.staging.ownership.get(job.id)?.cleanup);
  assert.equal(f.store.job(job.id).status, 'failed');
  fault.mock.restore();
  syncBuiltinESMExports();
  await f.cleanup.recover();
  assert.throws(() => f.store.job(job.id), /不存在/);
  assert.equal(f.staging.ownership.get(job.id), null);
});

test('an explicitly stored null ownership value is corruption, never permission to initialize a new ledger', async (t) => {
  const f = await fixture(t);
  f.store.set('stagingPartOwnership', null);
  await assert.rejects(f.cleanup.preview(), /不受支持/);
  const job = await f.staging.receive(
    f.result('null-ledger'),
    Readable.from('keep'),
  );
  assert.equal(job.status, 'failed');
  assert.equal(f.store.hasSetting('stagingPartOwnership'), true);
  assert.equal(f.store.get('stagingPartOwnership'), null);
});
