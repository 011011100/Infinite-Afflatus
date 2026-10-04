import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {
  PACKAGE_WORK_KEY,
  PackageRecovery,
  type PackageWorkRecord,
} from '../src/main/packages/package-recovery';
import { PackageWork } from '../src/main/packages/package-work';
import { ProjectPackageService } from '../src/main/packages/project-package-service';
import { Library } from '../src/main/storage/library';

async function fixture() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-package-recovery-')),
  );
  const data = join(base, 'app');
  const root = join(base, 'projects');
  const library = await Library.open(data, root);
  const packages = new ProjectPackageService(
    library.projects,
    library.store,
    library.gate,
    data,
  );
  const { project } = await library.projects.create('取消与恢复');
  const bytes = Buffer.alloc(1024 * 1024, 34);
  await library.acceptResult(
    {
      projectId: project.id,
      resultKey: 'video',
      name: 'source.mp4',
      kind: 'video',
      extension: 'mp4',
    },
    Readable.from([bytes, bytes, bytes, bytes]),
  );
  await library.saves.idle();
  return {
    base,
    data,
    root,
    library,
    packages,
    project,
    async dispose() {
      await packages.close();
      await library.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('cancel stops registered export work and allows a new operation; simultaneous operations are rejected', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const original = PackageWork.prototype.registerExternal;
  let registered = false;
  const stub = t.mock.method(
    PackageWork.prototype,
    'registerExternal',
    async function (
      this: PackageWork,
      path: string,
      identity: { dev: number; ino: number },
    ) {
      await original.call(this, path, identity);
      const records =
        f.library.store.get<PackageWorkRecord[]>(PACKAGE_WORK_KEY) ?? [];
      assert.ok(
        records.some((record) =>
          record.files.some((file) => file.path === path),
        ),
      );
      registered = true;
      f.packages.cancel();
    },
  );
  const result = f.packages.export(
    f.project.id,
    join(f.base, 'cancel.afflatus'),
  );
  await assert.rejects(f.packages.inspect(f.project.id), /已有项目包任务/);
  await assert.rejects(result, /已取消/);
  assert.ok(registered);
  assert.equal(
    (await readdir(f.base)).some(
      (name) => name.includes('.part') || name === 'cancel.afflatus',
    ),
    false,
  );
  assert.deepEqual(f.library.store.get(PACKAGE_WORK_KEY), []);
  stub.mock.restore();
  await f.packages.export(f.project.id, join(f.base, 'retry.afflatus'));
  assert.deepEqual(f.library.store.get(PACKAGE_WORK_KEY), []);
});

test('close cancels import after media-file creation, waits for cleanup and rejects further work', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const file = join(f.base, 'source.afflatus');
  await f.packages.export(f.project.id, file);
  const original = PackageWork.prototype.createFile;
  let closing: Promise<void> | undefined;
  t.mock.method(
    PackageWork.prototype,
    'createFile',
    async function (this: PackageWork, path: string) {
      const handle = await original.call(this, path);
      if (path.startsWith('assets/')) {
        const write = handle.write.bind(handle);
        t.mock.method(
          handle,
          'write',
          async (buffer: Buffer, offset: number, length: number) => {
            const result = await write(buffer, offset, length);
            closing = f.packages.close();
            return result;
          },
        );
      }
      return handle;
    },
  );
  await assert.rejects(f.packages.import(file), /已取消/);
  assert.ok(closing);
  await closing;
  assert.deepEqual(await readdir(f.root), [f.project.folder]);
  assert.deepEqual(f.library.store.get(PACKAGE_WORK_KEY), []);
  await assert.rejects(f.packages.inspect(f.project.id), /正在关闭/);
});

test('cancel interrupts duplicate media copying without registering a partial project', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const original = PackageWork.prototype.createFile;
  t.mock.method(
    PackageWork.prototype,
    'createFile',
    async function (this: PackageWork, path: string) {
      const handle = await original.call(this, path);
      if (path.startsWith('assets/')) {
        const write = handle.writeFile.bind(handle);
        t.mock.method(handle, 'writeFile', async (bytes: Buffer) => {
          await write(bytes);
          f.packages.cancel();
        });
      }
      return handle;
    },
  );
  await assert.rejects(f.packages.duplicate(f.project.id), /已取消/);
  assert.deepEqual(await readdir(f.root), [f.project.folder]);
  assert.deepEqual(f.library.store.get(PACKAGE_WORK_KEY), []);
});

test('cancellation during final cleanup preserves an already published package', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const original = PackageRecovery.prototype.clean;
  t.mock.method(
    PackageRecovery.prototype,
    'clean',
    async function (this: PackageRecovery, id?: string) {
      f.packages.cancel();
      await original.call(this, id);
    },
  );
  const file = join(f.base, 'published.afflatus');
  const result = await f.packages.export(f.project.id, file);
  assert.equal(result.path, file);
  assert.ok((await lstat(file)).size > 0);
});

test('restart recovery removes registered partial files while preserving unregistered files and replaced identities', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const journal = new PackageRecovery(f.library.store);
  const work = await PackageWork.create(f.data, journal);
  const file = await work.createFile('assets/videos/partial.mp4');
  await file.writeFile('partial large media');
  await file.close();
  const personal = join(work.root, 'personal.txt');
  await writeFile(personal, 'keep user bytes');
  const outside = join(f.base, '.backup.afflatus.partial.part');
  const output = await open(outside, 'wx');
  await work.registerExternal(outside, await output.stat());
  await output.writeFile('partial package');
  await output.close();
  const originalRoot = work.root;
  // Leave the ownership journal and files exactly as an interrupted process would.
  await f.library.close();
  const reopened = await Library.open(f.data, f.root);
  try {
    const recovery = new ProjectPackageService(
      reopened.projects,
      reopened.store,
      reopened.gate,
      f.data,
    );
    await recovery.recover();
    await assert.rejects(lstat(outside), { code: 'ENOENT' });
    await assert.rejects(
      lstat(join(originalRoot, 'assets/videos/partial.mp4')),
      { code: 'ENOENT' },
    );
    assert.equal(await readFile(personal, 'utf8'), 'keep user bytes');
    assert.ok(
      (reopened.store.get<PackageWorkRecord[]>(PACKAGE_WORK_KEY) ?? []).length,
    );
    await recovery.close();
  } finally {
    await reopened.close();
  }
});

test('offline export folders retain recovery ownership until available again', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const journal = new PackageRecovery(f.library.store);
  const work = await PackageWork.create(f.data, journal);
  const external = join(f.base, 'external-volume');
  await mkdir(external);
  const partial = join(external, '.backup.part');
  const output = await open(partial, 'wx');
  await work.registerExternal(partial, await output.stat());
  await output.writeFile('external bytes');
  await output.close();
  const offline = join(f.base, 'offline-volume');
  await rename(external, offline);
  await f.packages.recover();
  assert.equal(
    (f.library.store.get<PackageWorkRecord[]>(PACKAGE_WORK_KEY) ?? []).flatMap(
      (record) => record.files,
    ).length,
    1,
  );
  assert.equal(
    await readFile(join(offline, '.backup.part'), 'utf8'),
    'external bytes',
  );
  await rename(offline, external);
  await f.packages.recover();
  await assert.rejects(lstat(partial), { code: 'ENOENT' });
  assert.deepEqual(f.library.store.get(PACKAGE_WORK_KEY), []);
});

test('recovery does not follow replacement links or delete a successfully adopted project', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const journal = new PackageRecovery(f.library.store);
  const work = await PackageWork.create(f.root, journal);
  const handle = await work.createFile('project.sqlite');
  await handle.writeFile('complete database placeholder');
  await handle.close();
  const target = join(f.root, 'adopted-project');
  await rename(work.root, target); // Crash after atomic publication but before journal acknowledgement.
  await f.packages.recover();
  assert.equal(
    await readFile(join(target, 'project.sqlite'), 'utf8'),
    'complete database placeholder',
  );
  assert.deepEqual(f.library.store.get(PACKAGE_WORK_KEY), []);
  if (process.platform !== 'win32') {
    const replaced = await PackageWork.create(f.data, journal);
    const file = await replaced.createFile('project.sqlite');
    await file.close();
    await rm(join(replaced.root, 'project.sqlite'));
    const external = join(f.base, 'user-data');
    await writeFile(external, 'user-owned');
    await symlink(external, join(replaced.root, 'project.sqlite'));
    await f.packages.recover();
    assert.equal(await readFile(external, 'utf8'), 'user-owned');
  }
});
