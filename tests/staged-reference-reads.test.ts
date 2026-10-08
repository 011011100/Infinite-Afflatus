import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, {
  copyFile,
  link,
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
import { mediaFileResponse } from '../src/main/media/file-response';
import { ProjectReferenceReader } from '../src/main/saving/project-reference-reader';
import { Library } from '../src/main/storage/library';
import { emptyGenerationDraft } from '../src/shared/generation/draft';
import type { Asset } from '../src/shared/models';

async function fixture(t: TestContext) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-reference-read-')),
  );
  const library = await Library.open(join(base, 'app'), join(base, 'projects'));
  const { project } = await library.projects.create('完整但未保存');
  const pause = library.saves.pauseLocalReferences();
  const reader = new ProjectReferenceReader(
    library.projects,
    library.store,
    library.staging.directory,
  );
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    pause.resume();
    await library.close();
    await rm(base, { recursive: true, force: true });
  });
  const stage = async (
    kind: Asset['kind'] = 'text',
    bytes = Buffer.from('文本'),
  ) => {
    const extension = { text: 'txt', image: 'png', video: 'mp4', audio: 'wav' }[
      kind
    ];
    const job = await library.acceptResult(
      {
        projectId: project.id,
        resultKey: `reference:${randomUUID()}`,
        name: `参考.${extension}`,
        kind,
        usage: 'reference',
        extension,
      },
      Readable.from(bytes),
    );
    assert.equal(job.status, 'ready');
    return job;
  };
  return { base, library, project, pause, reader, stage };
}

const request = (range?: string, method = 'GET') =>
  new Request('https://media.test/reference', {
    method,
    headers: range ? { Range: range } : {},
  });

test('complete local references read through text and media entry points before saving, including while migration blocks writes', async (t) => {
  const f = await fixture(t);
  const text = await f.stage();
  const draft = await f.library.generation.save(f.project.id, {
    ...emptyGenerationDraft(),
    referenceIds: [text.id],
  });
  await f.library.gate.block();
  try {
    assert.equal(
      await f.library.generation.readText(f.project.id, text.id),
      '文本',
    );
    for (const [kind, mime] of [
      ['image', 'image/png'],
      ['video', 'video/mp4'],
      ['audio', 'audio/wav'],
    ] as const) {
      const job = await f.stage(kind, Buffer.from('0123456789'));
      const media = await f.reader.acquire(f.project.id, job.id);
      assert.ok(media);
      assert.equal(media.source, 'staged');
      const response = await mediaFileResponse(media, request('bytes=2-5'));
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-type'), mime);
      assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
      assert.equal(await response.text(), '2345');
      assert.equal(f.library.store.job(job.id).status, 'ready');
      assert.equal(
        await readFile(f.library.staging.path(job.id), 'utf8'),
        '0123456789',
      );
    }
    assert.equal(
      (await f.library.projects.open(f.project.id)).assets.length,
      0,
    );
    assert.deepEqual(await f.library.generation.read(f.project.id), draft);
  } finally {
    f.library.gate.release();
  }
});

test('staged fallback denies another project, wrong kinds, cloud results, unknown IDs and incomplete publication states', async (t) => {
  const f = await fixture(t);
  const other = await f.library.projects.create('其他项目');
  const job = await f.stage();
  assert.equal(await f.reader.acquire(other.project.id, job.id), null);
  assert.equal(await f.reader.acquire(f.project.id, job.id, 'image'), null);
  for (const patch of [
    { resultKey: 'cloud:task' },
    { usage: undefined },
    { status: 'receiving' as const },
    { status: 'saved' as const },
    { sha256: '' },
    { sha256: 'not-a-digest' },
    { extension: '../../source' },
    { extension: 'mp4' },
    { size: 0 },
  ]) {
    f.library.store.putJob({ ...job, ...patch });
    assert.equal(await f.reader.acquire(f.project.id, job.id), null);
  }
  f.library.store.putJob(job);
  const unknownId = randomUUID();
  const unknown = f.library.staging.path(unknownId);
  await copyFile(f.library.staging.path(job.id), unknown);
  assert.equal(await f.reader.acquire(f.project.id, unknownId), null);
  assert.equal(await readFile(unknown, 'utf8'), '文本');
  assert.equal(await f.reader.acquire(f.project.id, '../source'), null);
  await rename(
    f.library.staging.path(job.id),
    join(f.library.staging.directory, `${job.id}.part`),
  );
  f.library.store.putJob({ ...job, status: 'failed' });
  await assert.rejects(f.reader.acquire(f.project.id, job.id));
});

test('real cancelled reception never becomes readable and failed complete saves remain readable until retry', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const incomplete = await f.library.acceptResult(
    {
      projectId: f.project.id,
      resultKey: 'reference:cancelled',
      name: '取消.txt',
      kind: 'text',
      usage: 'reference',
      extension: 'txt',
    },
    Readable.from('partial'),
    {
      signal: controller.signal,
      onProgress: ({ bytes }) => {
        if (bytes) controller.abort();
      },
    },
  );
  assert.equal(incomplete.status, 'failed');
  assert.equal(await f.reader.acquire(f.project.id, incomplete.id), null);
  const job = await f.stage();
  const obstruction = join(
    f.library.store.root,
    f.project.folder,
    'assets/text',
  );
  await writeFile(obstruction, 'user-owned obstruction');
  f.pause.resume();
  await f.library.saves.idle();
  assert.equal(f.library.store.job(job.id).status, 'failed');
  assert.equal(
    await f.library.generation.readText(f.project.id, job.id),
    '文本',
  );
  assert.equal(await readFile(obstruction, 'utf8'), 'user-owned obstruction');
  await unlink(obstruction);
  await f.library.saves.retry(job.id);
  await f.library.saves.idle();
  assert.equal(f.library.store.job(job.id).status, 'saved');
  assert.equal(
    await f.library.generation.readText(f.project.id, job.id),
    '文本',
  );
  await assert.rejects(readFile(f.library.staging.path(job.id)), {
    code: 'ENOENT',
  });
});

test('opened staged descriptors retain bytes across successful save cleanup; subsequent reads prefer committed media', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(512 * 1024, 37);
  const job = await f.stage('audio', bytes);
  const media = await f.reader.acquire(f.project.id, job.id);
  assert.ok(media);
  assert.equal(media.source, 'staged');
  f.pause.resume();
  await f.library.saves.idle();
  await assert.rejects(readFile(f.library.staging.path(job.id)), {
    code: 'ENOENT',
  });
  const response = await mediaFileResponse(media, request());
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const current = await f.reader.acquire(f.project.id, job.id);
  assert.ok(current);
  assert.equal(current.source, 'committed');
  await current.handle.close();
});

test('registered missing originals cannot silently fall back to a retained saved stage', async (t) => {
  const f = await fixture(t);
  const job = await f.stage();
  const backup = join(f.base, 'retained');
  await copyFile(f.library.staging.path(job.id), backup);
  f.pause.resume();
  await f.library.saves.idle();
  await copyFile(backup, f.library.staging.path(job.id));
  const asset = (await f.library.projects.open(f.project.id)).assets.find(
    (item) => item.id === job.id,
  );
  assert.ok(asset);
  await unlink(
    join(f.library.store.root, f.project.folder, asset.relativePath),
  );
  await assert.rejects(f.reader.acquire(f.project.id, job.id));
  assert.equal(await readFile(f.library.staging.path(job.id), 'utf8'), '文本');
});

test('staged text keeps UTF-8 and size limits and closes rejected descriptors', async (t) => {
  const f = await fixture(t);
  const invalid = await f.stage('text', Buffer.from([0xff, 0xfe]));
  const large = await f.stage('text', Buffer.alloc(1024 * 1024 + 1, 65));
  await assert.rejects(
    f.library.generation.readText(f.project.id, invalid.id),
    /UTF-8/,
  );
  await assert.rejects(
    f.library.generation.readText(f.project.id, large.id),
    /1 MB/,
  );
});

test('tampering, symlinks, hardlink aliases and staging directory aliases fail closed without changing bytes', async (t) => {
  const f = await fixture(t);
  const job = await f.stage('text', Buffer.from('expected'));
  const path = f.library.staging.path(job.id);
  await writeFile(path, 'tampered');
  await assert.rejects(f.reader.acquire(f.project.id, job.id));
  assert.equal(await readFile(path, 'utf8'), 'tampered');
  await unlink(path);
  const source = join(f.base, 'source.txt');
  await writeFile(source, 'expected');
  await symlink(source, path);
  await assert.rejects(f.reader.acquire(f.project.id, job.id));
  await unlink(path);
  await link(source, path);
  await assert.rejects(f.reader.acquire(f.project.id, job.id));
  await unlink(path);
  await copyFile(source, path);
  const directory = f.library.staging.directory;
  const moved = `${directory}-original`;
  await rename(directory, moved);
  await symlink(moved, directory, 'dir');
  try {
    await assert.rejects(f.reader.acquire(f.project.id, job.id));
    assert.equal(await readFile(source, 'utf8'), 'expected');
  } finally {
    await unlink(directory);
    await rename(moved, directory);
  }
});

test('missing, foreign and aliased projects cannot borrow a valid complete stage', async (t) => {
  const f = await fixture(t);
  const other = await f.library.projects.create('其他身份');
  const job = await f.stage();
  const database = await f.library.projects.databasePath(f.project.id);
  const backup = `${database}-original`;
  await rename(database, backup);
  try {
    await assert.rejects(f.reader.acquire(f.project.id, job.id));
    await copyFile(
      await f.library.projects.databasePath(other.project.id),
      database,
    );
    await assert.rejects(f.reader.acquire(f.project.id, job.id), /不匹配/);
    await unlink(database);
    await symlink(backup, database);
    await assert.rejects(f.reader.acquire(f.project.id, job.id));
    await unlink(database);
  } finally {
    await rename(backup, database);
  }
  const root = f.library.store.root;
  await rename(root, `${root}-original`);
  await symlink(`${root}-original`, root, 'dir');
  try {
    await assert.rejects(f.reader.acquire(f.project.id, job.id));
  } finally {
    await unlink(root);
    await rename(`${root}-original`, root);
  }
});

test('file or directory replacement during verification is rejected even with identical replacement bytes', async (t) => {
  const f = await fixture(t);
  const job = await f.stage();
  const path = f.library.staging.path(job.id);
  const open = fs.open;
  for (const replaceDirectory of [false, true]) {
    let intercepted = false;
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (args[0] === path && !intercepted) {
        intercepted = true;
        const originalStat = handle.stat.bind(handle);
        let stats = 0;
        t.mock.method(
          handle,
          'stat',
          async (...parameters: Parameters<typeof handle.stat>) => {
            const info = await originalStat(...parameters);
            if (++stats === 2) {
              if (replaceDirectory) {
                await rename(
                  f.library.staging.directory,
                  `${f.library.staging.directory}-original`,
                );
                await mkdir(f.library.staging.directory);
              } else await rename(path, `${path}-original`);
              await writeFile(path, '文本');
            }
            return info;
          },
        );
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(f.reader.acquire(f.project.id, job.id), /已变化/);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await unlink(path);
    if (replaceDirectory) {
      await rm(f.library.staging.directory, { recursive: true });
      await rename(
        `${f.library.staging.directory}-original`,
        f.library.staging.directory,
      );
    } else await rename(`${path}-original`, path);
  }
});

test('verification racing a save re-resolves the current committed asset and closes the stale descriptor', async (t) => {
  const f = await fixture(t);
  const job = await f.stage();
  const path = f.library.staging.path(job.id);
  const open = fs.open;
  let raced = false;
  let closed = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === path && !raced) {
      raced = true;
      const read = handle.read.bind(handle);
      const close = handle.close.bind(handle);
      t.mock.method(
        handle,
        'read',
        async (...parameters: Parameters<typeof handle.read>) => {
          const result = await read(...parameters);
          f.pause.resume();
          await f.library.saves.idle();
          return result;
        },
      );
      t.mock.method(handle, 'close', async () => {
        closed = true;
        await close();
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  const media = await f.reader.acquire(f.project.id, job.id);
  assert.ok(media);
  assert.equal(media.source, 'committed');
  assert.equal(closed, true);
  assert.equal(await media.handle.readFile('utf8'), '文本');
  await media.handle.close();
});

test('active and new reads survive migration cutover and save to the current destination', async (t) => {
  const f = await fixture(t);
  const job = await f.stage();
  const active = await f.reader.acquire(f.project.id, job.id);
  assert.ok(active);
  const target = join(f.base, 'moved');
  await mkdir(target);
  const preview = await f.library.migration.prepare(target);
  await f.library.migration.start(preview.token);
  await f.library.migration.idle();
  assert.equal(f.library.state().migration?.phase, 'completed');
  assert.equal(await active.handle.readFile('utf8'), '文本');
  await active.handle.close();
  assert.equal(
    await f.library.generation.readText(f.project.id, job.id),
    '文本',
  );
  f.pause.resume();
  await f.library.saves.idle();
  const asset = (await f.library.projects.open(f.project.id)).assets.find(
    (item) => item.id === job.id,
  );
  assert.ok(asset);
  assert.equal(
    await readFile(join(target, f.project.folder, asset.relativePath), 'utf8'),
    '文本',
  );
  assert.equal(
    await f.library.generation.readText(f.project.id, job.id),
    '文本',
  );
});

test('opened committed media keeps its original bytes when migration cleans the old path', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(512 * 1024, 23);
  const job = await f.stage('video', bytes);
  f.pause.resume();
  await f.library.saves.idle();
  const active = await f.reader.acquire(f.project.id, job.id);
  assert.ok(active);
  assert.equal(active.source, 'committed');
  const asset = (await f.library.projects.open(f.project.id)).assets.find(
    (item) => item.id === job.id,
  );
  assert.ok(asset);
  const original = join(
    f.library.store.root,
    f.project.folder,
    asset.relativePath,
  );
  const target = join(f.base, 'moved');
  await mkdir(target);
  const preview = await f.library.migration.prepare(target);
  await f.library.migration.start(preview.token);
  await f.library.migration.idle();
  assert.equal(f.library.state().migration?.phase, 'completed');
  await assert.rejects(readFile(original), { code: 'ENOENT' });
  const response = await mediaFileResponse(
    active,
    request('bytes=490000-490009'),
  );
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    bytes.subarray(490000, 490010),
  );
  const current = await f.reader.acquire(f.project.id, job.id);
  assert.ok(current);
  assert.equal(current.source, 'committed');
  await current.handle.close();
});
