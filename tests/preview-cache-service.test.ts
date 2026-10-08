import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { mediaFileResponse } from '../src/main/media/file-response';
import { PreviewCacheService } from '../src/main/media/preview-cache-service';
import { ProxyService } from '../src/main/media/proxy-service';
import {
  readProxies,
  recordAsset,
  recordProxy,
} from '../src/main/projects/project-database';
import { fingerprint } from '../src/main/storage/files';
import { Library } from '../src/main/storage/library';

async function fixture(
  options: {
    encode?: (
      input: string,
      output: string,
      signal: AbortSignal,
    ) => Promise<void>;
    remove?: (file: string) => void;
  } = {},
) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-preview-cleanup-')),
  );
  const data = join(base, 'app');
  const library = await Library.open(data, join(base, 'projects'));
  const { project } = await library.projects.create('缓存验证');
  await library.acceptResult(
    {
      projectId: project.id,
      resultKey: 'source',
      name: 'source.mp4',
      kind: 'video',
      extension: 'mp4',
    },
    Readable.from('original source'),
  );
  await library.saves.idle();
  const asset = (await library.projects.open(project.id)).assets[0];
  assert.ok(asset);
  const database = await library.projects.databasePath(project.id);
  const root = dirname(database);
  let now = Date.now();
  let encodes = 0;
  const proxies = new ProxyService(
    library.projects,
    library.gate,
    library.store,
    data,
    options.encode ??
      (async (_input, output) => {
        encodes++;
        await writeFile(output, 'rebuilt proxy');
      }),
  );
  const cache = new PreviewCacheService(
    library.projects,
    library.gate,
    library.store,
    proxies,
    undefined,
    () => now,
    options.remove,
  );
  const addProxy = async (content = 'preview bytes', version = 1) => {
    const relativePath = `cache/proxy-v${version}-${randomUUID()}.mp4`;
    const file = join(root, relativePath);
    await writeFile(file, content);
    const record = {
      ...(await fingerprint(file)),
      relativePath,
      assetId: asset.id,
      sourceHash: asset.sha256,
      version,
    };
    recordProxy(database, record, project);
    return { file, record };
  };
  return {
    base,
    data,
    root,
    library,
    project,
    asset,
    database,
    proxies,
    cache,
    addProxy,
    get encodes() {
      return encodes;
    },
    advance: () => {
      now += 120_001;
    },
    async dispose() {
      await cache.close();
      await proxies.close();
      await library.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

const token = (value: { token: string | null }) => {
  assert.ok(value.token);
  return value.token;
};

test('inspection measures real cache files; cleanup preserves originals, unknowns, drafts and staging', async () => {
  const f = await fixture();
  try {
    const proxy = await f.addProxy();
    const unknown = join(f.root, 'cache', 'personal.mp4');
    await writeFile(unknown, 'user file');
    await mkdir(join(f.root, 'cache', 'personal-folder'));
    await writeFile(join(f.root, 'cache', 'personal-folder', 'keep'), 'nested');
    const draft = join(f.data, 'draft-do-not-touch');
    const staging = join(f.data, 'staging', 'keep-result');
    await writeFile(draft, 'draft');
    await writeFile(staging, 'complete result');
    const inspection = await f.cache.inspect();
    assert.equal(inspection.bytes, 'preview bytesuser file'.length);
    assert.equal(inspection.eligibleCount, 1);
    assert.equal(inspection.incomplete, true);
    const preview = await f.cache.preview();
    assert.equal(preview.files.length, 1);
    assert.equal(preview.retained.length, 2);
    const result = await f.cache.execute(token(preview));
    assert.equal(result.removedCount, 1);
    assert.equal(result.removedBytes, 'preview bytes'.length);
    await assert.rejects(readFile(proxy.file), { code: 'ENOENT' });
    assert.equal(
      await readFile(join(f.root, f.asset.relativePath), 'utf8'),
      'original source',
    );
    assert.equal(await readFile(unknown, 'utf8'), 'user file');
    assert.equal(await readFile(draft, 'utf8'), 'draft');
    assert.equal(await readFile(staging, 'utf8'), 'complete result');
    assert.equal((await f.cache.inspect()).eligibleCount, 0);
    assert.deepEqual(await f.proxies.ensure(f.project.id, f.asset.id), {
      ready: true,
    });
    assert.equal(f.encodes, 1);
    assert.ok(await f.proxies.file(f.project.id, f.asset.id));
  } finally {
    await f.dispose();
  }
});

test('unsafe records, symlinks, hardlinks and same-size replacements are retained', async () => {
  const f = await fixture();
  try {
    const replaced = await f.addProxy();
    await rename(replaced.file, `${replaced.file}.old`);
    await writeFile(replaced.file, 'preview bytes');
    const linked = await f.addProxy();
    await link(linked.file, join(f.base, 'second-link'));
    const symbolic = await f.addProxy();
    await rm(symbolic.file);
    await symlink(join(f.root, f.asset.relativePath), symbolic.file);
    recordProxy(
      f.database,
      { ...replaced.record, relativePath: f.asset.relativePath },
      f.project,
    );
    recordProxy(
      f.database,
      { ...replaced.record, relativePath: '../outside.mp4' },
      f.project,
    );
    const inspection = await f.cache.inspect();
    assert.equal(inspection.eligibleCount, 0);
    assert.ok(inspection.items.some((item) => item.reason.includes('身份')));
    assert.ok(inspection.items.some((item) => item.reason.includes('硬链接')));
    assert.ok(
      inspection.items.some((item) => item.reason.includes('符号链接')),
    );
    assert.ok(
      inspection.items.some(
        (item) => item.relativePath === '../outside.mp4' && item.bytes === null,
      ),
    );
    assert.equal((await f.cache.preview()).token, null);
  } finally {
    await f.dispose();
  }
});

test('confirmation revalidates original content and file identity even at unchanged length', async () => {
  const f = await fixture();
  try {
    const proxy = await f.addProxy();
    const preview = await f.cache.preview();
    await writeFile(join(f.root, f.asset.relativePath), 'modified source');
    const result = await f.cache.execute(token(preview));
    assert.equal(result.removedCount, 0);
    assert.equal(result.retained.length, 1);
    assert.equal(await readFile(proxy.file, 'utf8'), 'preview bytes');
    assert.equal((await f.cache.preview()).token, null);
  } finally {
    await f.dispose();
  }
});

test('cache and project directory replacement invalidate confirmation without deleting replacements', async () => {
  for (const target of ['cache', 'project']) {
    const f = await fixture();
    try {
      const proxy = await f.addProxy();
      const preview = await f.cache.preview();
      if (target === 'cache') {
        await rename(join(f.root, 'cache'), join(f.root, 'cache-old'));
        await mkdir(join(f.root, 'cache'));
        await writeFile(proxy.file, 'replacement');
      } else {
        await rename(f.root, `${f.root}-old`);
        await mkdir(f.root);
      }
      const result = await f.cache.execute(token(preview));
      assert.equal(result.removedCount, 0);
      assert.equal(result.retained.length, 1);
      if (target === 'cache')
        assert.equal(await readFile(proxy.file, 'utf8'), 'replacement');
    } finally {
      await f.dispose();
    }
  }
});

test('tokens expire, are single use, and are invalidated by inspection, cancel and newer previews', async () => {
  const f = await fixture();
  try {
    await f.addProxy();
    let preview = await f.cache.preview();
    f.advance();
    await assert.rejects(f.cache.execute(token(preview)), /失效/);
    preview = await f.cache.preview();
    f.cache.cancel();
    await assert.rejects(f.cache.execute(token(preview)), /失效/);
    preview = await f.cache.preview();
    await f.cache.inspect();
    await assert.rejects(f.cache.execute(token(preview)), /失效/);
    preview = await f.cache.preview();
    const newer = await f.cache.preview();
    await assert.rejects(f.cache.execute(token(preview)), /失效/);
    // Any execution attempt consumes the pending confirmation, including wrong tokens.
    await assert.rejects(f.cache.execute(token(newer)), /失效/);
    preview = await f.cache.preview();
    assert.equal((await f.cache.execute(token(preview))).removedCount, 1);
    await assert.rejects(f.cache.execute(token(preview)), /失效/);
  } finally {
    await f.dispose();
  }
});

test('editor protection and active range streams retain previews until their leases close', async () => {
  const f = await fixture();
  try {
    await f.addProxy('x'.repeat(1024 * 1024));
    const preview = await f.cache.preview();
    const release = f.proxies.protect(f.project.id, [f.asset.id]);
    assert.equal((await f.cache.execute(token(preview))).removedCount, 0);
    assert.equal((await f.cache.inspect()).eligibleCount, 0);
    release();
    release();
    const leased = await f.proxies.acquireFile(f.project.id, f.asset.id);
    assert.ok(leased);
    const response = await mediaFileResponse(
      leased.file,
      new Request('https://media.test/preview'),
      leased.release,
    );
    assert.equal((await f.cache.inspect()).eligibleCount, 0);
    await response.body?.cancel();
    for (
      let i = 0;
      i < 50 && f.proxies.busyReason(f.project.id, f.asset.id);
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(f.proxies.busyReason(f.project.id, f.asset.id), null);
    assert.equal((await f.cache.inspect()).eligibleCount, 1);
  } finally {
    await f.dispose();
  }
});

test('queued generation and active encoder work are protected and independent work files untouched', async () => {
  let started!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const release = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = await fixture({
    encode: async (_input, output) => {
      started();
      await release;
      await writeFile(output, 'fresh');
    },
  });
  try {
    const older = await f.addProxy('older preview', 2);
    const preview = await f.cache.preview();
    const pending = f.proxies.ensure(f.project.id, f.asset.id);
    await entered;
    assert.equal((await f.cache.execute(token(preview))).removedCount, 0);
    assert.equal((await f.cache.inspect()).eligibleCount, 0);
    assert.equal(await readFile(older.file, 'utf8'), 'older preview');
    finish();
    assert.deepEqual(await pending, { ready: true });
    assert.equal((await f.cache.inspect()).eligibleCount, 2);
  } finally {
    finish();
    await f.dispose();
  }
});

test('migration invalidates old confirmation and retains safe cleanup eligibility at the new root', async () => {
  const f = await fixture();
  try {
    await f.addProxy();
    const preview = await f.cache.preview();
    await f.library.gate.block();
    await assert.rejects(f.cache.inspect(), /迁移/);
    f.library.gate.release();
    const migrationToken = await f.cache.preview();
    const target = join(f.base, 'moved');
    await mkdir(target);
    const migration = await f.library.migration.prepare(target);
    await f.library.migration.start(migration.token);
    await f.library.migration.idle();
    const stale = await f.cache.execute(token(migrationToken));
    assert.equal(stale.removedCount, 0);
    assert.equal(stale.retained.length, 1);
    await assert.rejects(f.cache.execute(token(preview)), /失效/);
    const current = await f.cache.preview();
    assert.equal(current.files.length, 1);
    assert.equal((await f.cache.execute(token(current))).removedCount, 1);
    assert.deepEqual(await f.proxies.ensure(f.project.id, f.asset.id), {
      ready: true,
    });
  } finally {
    f.library.gate.release();
    await f.dispose();
  }
});

test('partial unlink failures and mid-cleanup cancellation report exact removed bytes', async () => {
  let removals = 0;
  const f = await fixture({
    remove: (file) => {
      if (++removals === 2) throw new Error('模拟无权限');
      unlinkSync(file);
    },
  });
  try {
    await f.addProxy('aaaa');
    await f.addProxy('bbbb');
    const preview = await f.cache.preview();
    const result = await f.cache.execute(token(preview));
    assert.equal(result.removedCount, 1);
    assert.equal(result.removedBytes, 4);
    assert.equal(result.retained.length, 1);
    assert.match(result.retained[0]?.reason ?? '', /无权限/);
    assert.equal((await f.cache.inspect()).eligibleCount, 1);
  } finally {
    await f.dispose();
  }
  let cancel!: () => void;
  const c = await fixture({
    remove: (file) => {
      unlinkSync(file);
      cancel();
    },
  });
  cancel = () => c.cache.cancel();
  try {
    await c.addProxy('aaaa');
    await c.addProxy('bbbb');
    const result = await c.cache.execute(token(await c.cache.preview()));
    assert.equal(result.removedCount, 1);
    assert.equal(result.removedBytes, 4);
    assert.equal(result.cancelled, true);
    assert.equal(result.retained.length, 1);
  } finally {
    await c.dispose();
  }
});

test('reopening after cleanup keeps source and manifest readable and rebuilds on demand', async () => {
  const f = await fixture();
  try {
    await f.addProxy();
    await f.cache.execute(token(await f.cache.preview()));
    assert.equal(readProxies(f.database, f.project).length, 1);
    await f.cache.close();
    await f.proxies.close();
    await f.library.close();
    const reopened = await Library.open(f.data, join(f.base, 'projects'));
    const proxies = new ProxyService(
      reopened.projects,
      reopened.gate,
      reopened.store,
      f.data,
      async (_input, output) => {
        await writeFile(output, 'reopened preview');
      },
    );
    try {
      assert.equal(
        (await reopened.projects.open(f.project.id)).assets[0]?.sha256,
        f.asset.sha256,
      );
      assert.deepEqual(await proxies.ensure(f.project.id, f.asset.id), {
        ready: true,
      });
      const file = await proxies.file(f.project.id, f.asset.id);
      assert.ok(file);
      assert.equal(await readFile(file, 'utf8'), 'reopened preview');
    } finally {
      await proxies.close();
      await reopened.close();
    }
  } finally {
    await f.dispose();
  }
});

test('metadata changes and missing originals retain confirmed previews', async () => {
  const f = await fixture();
  try {
    const proxy = await f.addProxy();
    const preview = await f.cache.preview();
    recordProxy(
      f.database,
      { ...proxy.record, sourceHash: '0'.repeat(64) },
      f.project,
    );
    const changed = await f.cache.execute(token(preview));
    assert.equal(changed.removedCount, 0);
    assert.match(changed.retained[0]?.reason ?? '', /变化/);
    recordProxy(f.database, proxy.record, f.project);
    await rm(join(f.root, f.asset.relativePath));
    assert.equal((await f.cache.preview()).files.length, 0);
    assert.equal(await readFile(proxy.file, 'utf8'), 'preview bytes');
  } finally {
    await f.dispose();
  }
});

test('all registered projects are inspected without counting original video bytes', async () => {
  const f = await fixture();
  try {
    await f.addProxy('first');
    const { project } = await f.library.projects.create('第二个项目');
    await f.library.acceptResult(
      {
        projectId: project.id,
        resultKey: 'second',
        name: 'second.mp4',
        kind: 'video',
        extension: 'mp4',
      },
      Readable.from('second source is long'),
    );
    await f.library.saves.idle();
    const asset = (await f.library.projects.open(project.id)).assets[0];
    assert.ok(asset);
    const database = await f.library.projects.databasePath(project.id);
    const relativePath = `cache/proxy-v1-${randomUUID()}.mp4`;
    const file = join(dirname(database), relativePath);
    await writeFile(file, 'second');
    recordProxy(
      database,
      {
        ...(await fingerprint(file)),
        relativePath,
        assetId: asset.id,
        sourceHash: asset.sha256,
        version: 1,
      },
      project,
    );
    const inspection = await f.cache.inspect();
    assert.equal(inspection.eligibleCount, 2);
    assert.equal(inspection.bytes, 11);
    assert.equal(
      new Set(inspection.items.map((item) => item.projectId)).size,
      2,
    );
  } finally {
    await f.dispose();
  }
});

test('cancelled queued inspection cannot later publish a confirmation token', async () => {
  const f = await fixture();
  try {
    await f.addProxy();
    let release!: () => void;
    const held = f.library.gate.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const pending = f.cache.preview();
    f.cache.cancel();
    release();
    await held;
    await assert.rejects(pending, /取消/);
    const current = await f.cache.preview();
    assert.equal((await f.cache.execute(token(current))).removedCount, 1);
  } finally {
    await f.dispose();
  }
});

test('a cancelled later migration conservatively retains cache when original ownership evidence was replaced', async () => {
  const f = await fixture();
  try {
    await f.addProxy();
    const first = join(f.base, 'first-move');
    const second = join(f.base, 'second-move');
    await mkdir(first);
    await mkdir(second);
    const move = await f.library.migration.prepare(first);
    await f.library.migration.start(move.token);
    await f.library.migration.idle();
    assert.equal((await f.cache.inspect()).eligibleCount, 1);
    const next = await f.library.migration.prepare(second);
    await f.library.migration.start(next.token);
    f.library.migration.cancel();
    await f.library.migration.idle();
    assert.equal(f.library.store.root, first);
    const retained = await f.cache.inspect();
    assert.equal(retained.eligibleCount, 0);
    assert.ok(retained.items.some((item) => item.reason.includes('身份')));
    assert.ok(await f.proxies.file(f.project.id, f.asset.id));
  } finally {
    await f.dispose();
  }
});

test('registered originals using dot-path aliases can never be treated as derived cleanup files', async () => {
  const f = await fixture();
  try {
    const proxy = await f.addProxy();
    recordAsset(
      f.database,
      'aliased-original',
      {
        id: randomUUID(),
        name: 'user original.mp4',
        kind: 'video',
        relativePath: proxy.record.relativePath.replace('cache/', 'cache/./'),
        size: proxy.record.size,
        sha256: proxy.record.sha256,
      },
      f.project,
    );
    const inspection = await f.cache.inspect();
    assert.equal(inspection.eligibleCount, 0);
    assert.ok(
      inspection.items.some((item) => item.reason.includes('登记的原素材')),
    );
    assert.equal((await f.cache.preview()).token, null);
    assert.equal(await readFile(proxy.file, 'utf8'), 'preview bytes');
  } finally {
    await f.dispose();
  }
});

test('case aliases of registered originals are protected on case-insensitive filesystems', async (t) => {
  const f = await fixture();
  try {
    const proxy = await f.addProxy();
    const alias = proxy.record.relativePath.replace('proxy-', 'PROXY-');
    try {
      await readFile(join(f.root, alias));
    } catch {
      t.skip(
        'Filesystem is case-sensitive; dot-path alias regression still applies',
      );
      return;
    }
    recordAsset(
      f.database,
      'case-aliased-original',
      {
        id: randomUUID(),
        name: 'original',
        kind: 'video',
        relativePath: alias,
        size: proxy.record.size,
        sha256: proxy.record.sha256,
      },
      f.project,
    );
    assert.equal((await f.cache.inspect()).eligibleCount, 0);
    assert.equal(await readFile(proxy.file, 'utf8'), 'preview bytes');
  } finally {
    await f.dispose();
  }
});

test('unsafe unrelated original references also fail closed before cleanup', async () => {
  const f = await fixture();
  try {
    const proxy = await f.addProxy();
    recordAsset(
      f.database,
      'unsafe-original',
      {
        id: randomUUID(),
        name: 'missing',
        kind: 'video',
        relativePath: '../unsafe.mp4',
        size: 1,
        sha256: '0'.repeat(64),
      },
      f.project,
    );
    assert.equal((await f.cache.inspect()).eligibleCount, 0);
    assert.equal(await readFile(proxy.file, 'utf8'), 'preview bytes');
  } finally {
    await f.dispose();
  }
});
