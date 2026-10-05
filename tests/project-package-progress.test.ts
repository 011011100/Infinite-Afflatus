import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type TestContext, test } from 'node:test';
import { readPackageHeader } from '../src/main/packages/package-format';
import {
  PackageCancelledError,
  type PackageProgress,
} from '../src/main/packages/package-progress';
import { PackageRecovery } from '../src/main/packages/package-recovery';
import { Library } from '../src/main/storage/library';
import type { ProjectPackageProgress } from '../src/shared/project-package';

async function fixture(t: TestContext) {
  const base = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), 'afflatus-package-progress-')),
  );
  const library = await Library.open(join(base, 'app'), join(base, 'projects'));
  const { project } = await library.projects.create('真实进度');
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 117, 37);
  await library.acceptResult(
    {
      projectId: project.id,
      resultKey: 'progress-source',
      name: 'media.txt',
      kind: 'text',
      extension: 'txt',
      usage: 'reference',
    },
    Readable.from(bytes),
  );
  await library.saves.idle();
  const snapshot = await library.projects.open(project.id);
  const asset = snapshot.assets[0];
  assert.ok(asset);
  const source = join(library.store.root, project.folder, asset.relativePath);
  t.after(async () => {
    await library.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, library, project, bytes, source };
}
function assertProgress(
  events: PackageProgress[],
  total: number,
  files: number,
) {
  assert.equal(events[0]?.phase, 'waiting');
  assert.equal(events.at(-1)?.phase, 'completed');
  assert.equal(events.at(-1)?.completedBytes, total);
  assert.equal(events.at(-1)?.totalBytes, total);
  assert.equal(events.at(-1)?.completedFiles, files);
  assert.ok(
    events.some(
      (value) =>
        value.phase === 'copying' &&
        value.completedBytes > 0 &&
        value.completedBytes < total,
    ),
  );
  assert.ok(
    events.some(
      (value) => value.phase === 'finalizing' && value.canCancel === false,
    ),
  );
  for (let i = 1; i < events.length; i++)
    assert.ok(
      (events[i]?.completedBytes ?? 0) >= (events[i - 1]?.completedBytes ?? 0),
    );
}

test('export/import/duplicate report exact written payload bytes while source media is read only once per copying operation', async (t) => {
  const f = await fixture(t);
  const path = join(f.base, 'complete.afflatus');
  const open = fs.open;
  let sourceOpens = 0;
  const mock = t.mock.method(
    fs,
    'open',
    async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === f.source) sourceOpens++;
      return open(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    const exported: PackageProgress[] = [];
    await f.library.packages.export(f.project.id, path, {
      onProgress: (value) => exported.push(value),
    });
    assert.equal(
      sourceOpens,
      1,
      'hashing and packing share the same media read',
    );
    const input = await fs.open(path, 'r');
    const { manifest } = await readPackageHeader(input);
    await input.close();
    const total = manifest.entries.reduce((sum, entry) => sum + entry.size, 0);
    assertProgress(exported, total, 2);
    assert.ok(
      (await fs.stat(path)).size > total,
      'archive header is not counted as payload',
    );
    const imported: PackageProgress[] = [];
    const copy = await f.library.packages.import(path, {
      onProgress: (value) => imported.push(value),
    });
    assertProgress(imported, total, 2);
    assert.deepEqual(
      await fs.readFile(
        join(
          f.library.store.root,
          copy.project.folder,
          copy.assets[0]?.relativePath ?? '',
        ),
      ),
      f.bytes,
    );
    const duplicated: PackageProgress[] = [];
    await f.library.packages.duplicate(f.project.id, undefined, {
      onProgress: (value) => duplicated.push(value),
    });
    assert.equal(
      sourceOpens,
      2,
      'duplicate hashes while copying and does not re-read the media',
    );
    assertProgress(duplicated, f.bytes.length, 1);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('real positive-byte cancellation returns null only after external part and owned work are cleaned', async (t) => {
  const f = await fixture(t);
  const path = join(f.base, 'cancelled.afflatus');
  const events: ProjectPackageProgress[] = [];
  const requestId = randomUUID();
  let cancellation: Promise<void> | undefined;
  const result = await f.library.packageRequests.run(
    1,
    requestId,
    'export',
    f.project.id,
    async () => path,
    (selected, controls) =>
      f.library.packages.export(f.project.id, selected, controls),
    (value) => {
      events.push(value);
      if (
        !cancellation &&
        value.phase === 'copying' &&
        value.completedBytes > 128 * 1024
      )
        cancellation = f.library.packageRequests.cancel(1, requestId);
    },
  );
  assert.equal(result, null);
  assert.ok(cancellation);
  await cancellation;
  assert.equal(events.at(-1)?.phase, 'cancelled');
  assert.ok(events.some((value) => value.completedBytes > 0));
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
  assert.deepEqual(f.library.store.get('project-package-work'), []);
  assert.equal(
    (await fs.readdir(f.base)).some(
      (name) => name.endsWith('.part') || name === 'cancelled.afflatus',
    ),
    false,
  );
});

test('cleanup I/O failure remains a failure even when cancellation was requested; owned recovery records survive', async (t) => {
  const f = await fixture(t);
  const path = join(f.base, 'cleanup.afflatus');
  const unlink = fs.unlink;
  const mock = t.mock.method(
    fs,
    'unlink',
    async (...args: Parameters<typeof fs.unlink>) => {
      if (String(args[0]).endsWith('.part'))
        throw Object.assign(new Error('fixture readonly destination'), {
          code: 'EACCES',
        });
      return unlink(...args);
    },
  );
  syncBuiltinESMExports();
  const events: PackageProgress[] = [];
  try {
    await assert.rejects(
      f.library.packages.export(f.project.id, path, {
        onProgress: (value) => {
          events.push(value);
          if (value.phase === 'copying' && value.completedBytes > 0)
            f.library.packages.cancel();
        },
      }),
      (error) =>
        error instanceof Error &&
        !(error instanceof PackageCancelledError) &&
        error.message.includes('清理'),
    );
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(events.at(-1)?.phase, 'failed');
  assert.notDeepEqual(f.library.store.get('project-package-work'), []);
  await f.library.packages.recover();
  assert.deepEqual(f.library.store.get('project-package-work'), []);
  assert.deepEqual(await fs.readFile(f.source), f.bytes);
});

test('late abort and cleanup failure cannot turn a durably published archive into cancellation or delete it', async (t) => {
  const f = await fixture(t);
  const path = join(f.base, 'published.afflatus');
  const clean = PackageRecovery.prototype.clean;
  const mock = t.mock.method(
    PackageRecovery.prototype,
    'clean',
    async function (this: PackageRecovery, id?: string) {
      if (id) {
        f.library.packages.cancel();
        throw new Error('fixture cleanup rejected');
      }
      return clean.call(this, id);
    },
  );
  const events: PackageProgress[] = [];
  try {
    await assert.rejects(
      f.library.packages.export(f.project.id, path, {
        onProgress: (value) => events.push(value),
      }),
      /fixture cleanup rejected/,
    );
  } finally {
    mock.mock.restore();
  }
  assert.equal(events.at(-1)?.phase, 'failed');
  const input = await fs.open(path, 'r');
  await readPackageHeader(input);
  await input.close();
  await f.library.packages.recover();
  assert.ok((await fs.stat(path)).isFile());
});

test('a request cancelled while queued on the write gate never creates package work', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const blocked = f.library.gate.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const events: PackageProgress[] = [];
  const pending = f.library.packages.export(
    f.project.id,
    join(f.base, 'waiting.afflatus'),
    { signal: controller.signal, onProgress: (value) => events.push(value) },
  );
  controller.abort();
  release();
  await blocked;
  await assert.rejects(pending, PackageCancelledError);
  assert.deepEqual(
    events.map((value) => value.phase),
    ['waiting', 'cancelled'],
  );
  assert.equal(f.library.store.get('project-package-work'), null);
});
