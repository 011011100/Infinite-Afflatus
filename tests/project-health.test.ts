import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  recordAsset,
  withProject,
} from '../src/main/projects/project-database';
import { RepairWork } from '../src/main/recovery/repair-work';
import { restoreAsset } from '../src/main/recovery/restore-asset';
import { verifyFile } from '../src/main/recovery/verified-file';
import { Library } from '../src/main/storage/library';
import type { Asset } from '../src/shared/models';

async function fixture() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-health-')),
  );
  const library = await Library.open(join(base, 'app'), join(base, 'projects'));
  const snapshot = await library.projects.create('恢复检查');
  const projectId = snapshot.project.id;
  const database = await library.projects.databasePath(projectId);
  const root = dirname(database);
  return {
    base,
    library,
    root,
    projectId,
    database,
    async add(
      kind: Asset['kind'] = 'video',
      bytes = Buffer.from('original-media-bytes'),
    ) {
      const id = randomUUID();
      const relativePath = `assets/${kind === 'video' ? 'videos' : kind === 'image' ? 'images' : kind}/${id}.dat`;
      const asset: Asset = {
        id,
        relativePath,
        name: `素材-${kind}`,
        kind,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        ...(kind !== 'video' ? { usage: 'reference' as const } : {}),
      };
      await mkdir(dirname(join(root, relativePath)), { recursive: true });
      await writeFile(join(root, relativePath), bytes);
      recordAsset(database, id, asset, snapshot.project);
      return { asset, path: join(root, relativePath), bytes };
    },
    async dispose() {
      await library.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('quick scan distinguishes missing/size mismatch; full scan catches same-size substitutions and unsafe paths', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const missing = await f.add();
  const sized = await f.add('image');
  const replaced = await f.add('audio');
  const unsafe = await f.add('text');
  await unlink(missing.path);
  await writeFile(sized.path, 'changed size');
  await writeFile(replaced.path, Buffer.alloc(replaced.bytes.length, 3));
  await unlink(unsafe.path);
  await symlink(replaced.path, unsafe.path);
  const quick = await f.library.health.scan(f.projectId, 'quick');
  assert.equal(quick.assetCount, 4);
  assert.deepEqual(
    quick.issues.map((i) => [i.assetId, i.problem]),
    [
      [missing.asset.id, 'missing'],
      [sized.asset.id, 'changed'],
      [unsafe.asset.id, 'unsafe'],
    ],
  );
  const full = await f.library.health.scan(f.projectId, 'full');
  assert.equal(
    full.issues.find((i) => i.assetId === replaced.asset.id)?.problem,
    'changed',
  );
  assert.equal(full.issues.length, 4);
});

test('exact missing-file restore keeps database bytes, asset IDs, canvas order/trims and source untouched', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const original = await f.add();
  const snapshot = await f.library.projects.open(f.projectId);
  const card = snapshot.canvas.cards[0];
  assert.ok(card);
  await f.library.projects.patchCanvas(f.projectId, {
    before: [card],
    after: [{ ...card, trims: { [original.asset.id]: { start: 1, end: 4 } } }],
  });
  const expected = await f.library.projects.open(f.projectId);
  const dbBytes = await readFile(f.database);
  const source = join(f.base, '原素材.mp4');
  await copyFile(original.path, source);
  await unlink(original.path);
  await assert.rejects(f.library.packages.inspect(f.projectId));
  const result = await f.library.health.restore(
    f.projectId,
    original.asset.id,
    source,
  );
  assert.deepEqual(result.issues, []);
  assert.deepEqual(await readFile(original.path), original.bytes);
  assert.deepEqual(await readFile(source), original.bytes);
  assert.deepEqual(await readFile(f.database), dbBytes);
  assert.deepEqual(await f.library.projects.open(f.projectId), expected);
  assert.equal((await f.library.packages.inspect(f.projectId)).assetCount, 1);
  assert.deepEqual(await readdir(join(f.base, 'app/asset-recovery')), []);
  assert.deepEqual(f.library.store.get('asset-repair-work'), []);
});

test('restore refuses different content and any existing file, preserving all conflicting bytes', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const original = await f.add();
  const source = join(f.base, 'source');
  const bad = Buffer.alloc(original.bytes.length, 9);
  await writeFile(source, bad);
  await unlink(original.path);
  await assert.rejects(
    f.library.health.restore(f.projectId, original.asset.id, source),
    /内容不一致/,
  );
  await assert.rejects(readFile(original.path), { code: 'ENOENT' });
  await writeFile(original.path, bad);
  await writeFile(source, original.bytes);
  await assert.rejects(
    f.library.health.restore(f.projectId, original.asset.id, source),
    /已有文件/,
  );
  assert.deepEqual(await readFile(original.path), bad);
  assert.deepEqual(f.library.store.get('asset-repair-work'), []);
});

test('a file appearing during restoration is never replaced; cancelling before a native selection has a durable operation epoch', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const original = await f.add();
  const source = join(f.base, 'source');
  await rename(original.path, source);
  const stop = f.library.health.subscribe((state) => {
    if (state?.operation === 'restore' && state.progress === 0)
      writeFileSync(original.path, 'concurrent external file', { flag: 'wx' });
  });
  await assert.rejects(
    f.library.health.restore(f.projectId, original.asset.id, source),
    /已有文件/,
  );
  stop();
  assert.equal(
    await readFile(original.path, 'utf8'),
    'concurrent external file',
  );
  assert.deepEqual(f.library.store.get('asset-repair-work'), []);
  const before = f.library.health.cancellationVersion;
  f.library.health.cancel();
  assert.equal(f.library.health.cancellationVersion, before + 1);
  await f.library.health.close();
  assert.equal(f.library.health.cancellationVersion, before + 2);
});

test('closing an active scan cancels it before gate drain and does not stall project writes', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  await f.add('video', Buffer.alloc(1024 * 1024, 1));
  let closing: Promise<void> | undefined;
  f.library.health.subscribe((state) => {
    if (state?.operation === 'scan') closing = f.library.health.close();
  });
  await assert.rejects(f.library.health.scan(f.projectId, 'full'), /取消/);
  await closing;
  await f.library.projects.update(f.projectId, { name: '关闭检查后可保存' });
  assert.equal(
    (await f.library.projects.open(f.projectId)).project.name,
    '关闭检查后可保存',
  );
});

test('cancellation during final publication validation never exposes the restored file', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const original = await f.add();
  const source = join(f.base, 'source');
  await rename(original.path, source);
  const controller = new AbortController();
  const work = new RepairWork(f.library.store);
  const validate = work.validate.bind(work);
  let validations = 0;
  t.mock.method(work, 'validate', async (id: string) => {
    const file = await validate(id);
    if (++validations === 2) controller.abort(new Error('临近发布时取消'));
    return file;
  });
  await assert.rejects(
    restoreAsset(
      f.library.projects,
      work,
      join(f.base, 'app'),
      f.projectId,
      original.asset.id,
      source,
      controller.signal,
      () => {},
    ),
    /临近发布时取消/,
  );
  assert.equal(validations, 2);
  await assert.rejects(readFile(original.path), { code: 'ENOENT' });
  assert.deepEqual(f.library.store.get('asset-repair-work'), []);
});

test('corrupt, future-version and missing databases reject diagnosis without replacement or an empty-success report', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const original = await readFile(f.database);
  withProject(f.database, true, (db) => db.exec('PRAGMA user_version = 999'));
  const newer = await readFile(f.database);
  await assert.rejects(f.library.health.scan(f.projectId, 'quick'), /版本/);
  assert.deepEqual(await readFile(f.database), newer);
  await writeFile(f.database, Buffer.from('broken database'));
  await assert.rejects(f.library.health.scan(f.projectId, 'full'));
  assert.equal(await readFile(f.database, 'utf8'), 'broken database');
  await unlink(f.database);
  await assert.rejects(f.library.health.scan(f.projectId, 'quick'), {
    code: 'ENOENT',
  });
  await assert.rejects(readFile(f.database), { code: 'ENOENT' });
  await writeFile(f.database, original);
});

test('cancellation stops bounded reads and leaves no restored asset or temporary files', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const original = await f.add('video', Buffer.alloc(2 * 1024 * 1024, 7));
  const source = join(f.base, 'source');
  await rename(original.path, source);
  const stop = f.library.health.subscribe((state) => {
    if (state?.operation === 'restore') f.library.health.cancel();
  });
  await assert.rejects(
    f.library.health.restore(f.projectId, original.asset.id, source),
    /取消/,
  );
  stop();
  await assert.rejects(readFile(original.path), { code: 'ENOENT' });
  assert.deepEqual(f.library.store.get('asset-repair-work'), []);
  const controller = new AbortController();
  let consumed = 0;
  await assert.rejects(
    verifyFile(source, original.asset.size, controller.signal, (bytes) => {
      consumed = bytes;
      controller.abort();
    }),
  );
  assert.equal(consumed, 256 * 1024);
  assert.equal((await readFile(source)).length, original.asset.size);
});

test('repair re-resolves the project after gate admission and rejects when migration owns admission', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const original = await f.add();
  const source = join(f.base, 'source');
  await rename(original.path, source);
  const moved = join(f.base, 'moved-projects');
  const relocation = f.library.gate.run(async () => {
    await rename(f.library.store.root, moved);
    f.library.store.set('root', moved);
  });
  const repair = f.library.health.restore(
    f.projectId,
    original.asset.id,
    source,
  );
  await relocation;
  await repair;
  assert.deepEqual(
    await readFile(join(moved, f.projectId, original.asset.relativePath)),
    original.bytes,
  );
  await f.library.gate.block();
  await assert.rejects(f.library.health.scan(f.projectId, 'full'), /迁移/);
  f.library.gate.release();
});

test('recovery only removes its registered inode and never follows links or removes a published asset', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const work = new RepairWork(f.library.store);
  const keep = join(f.base, 'unrelated.txt');
  await writeFile(keep, 'keep');
  const own = await work.create(f.root);
  await own.handle.writeFile('complete bytes');
  await own.handle.close();
  const published = join(f.root, 'restored.bin');
  await link(own.path, published);
  await new RepairWork(f.library.store).clean();
  assert.equal(await readFile(published, 'utf8'), 'complete bytes');
  const replaced = await work.create(f.root);
  await replaced.handle.close();
  await unlink(replaced.path);
  await symlink(keep, replaced.path);
  await work.clean();
  assert.equal(await readFile(keep, 'utf8'), 'keep');
  assert.equal(await readFile(replaced.path, 'utf8'), 'keep');
  const parent = join(f.base, 'interrupted');
  await mkdir(parent);
  const temporary = await work.create(parent);
  await temporary.handle.close();
  await rename(parent, `${parent}-moved`);
  await work.clean();
  assert.equal(
    (f.library.store.get<unknown[]>('asset-repair-work') ?? []).length,
    2,
  );
});

test('restore safely recreates missing managed asset folders but refuses a linked parent', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const original = await f.add('audio');
  const source = join(f.base, 'source');
  await rename(original.path, source);
  await rm(dirname(original.path), { recursive: true });
  await f.library.health.restore(f.projectId, original.asset.id, source);
  assert.deepEqual(await readFile(original.path), original.bytes);
  await rm(dirname(original.path), { recursive: true });
  await symlink(f.base, dirname(original.path));
  await assert.rejects(
    f.library.health.restore(f.projectId, original.asset.id, source),
    /只能恢复缺失/,
  );
  await assert.rejects(
    readFile(join(f.base, original.asset.relativePath.split('/').at(-1) ?? '')),
    { code: 'ENOENT' },
  );
});
