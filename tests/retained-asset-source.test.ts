import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
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
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import type {
  BrowserWindow,
  IpcMainInvokeEvent,
  MessageBoxOptions,
} from 'electron';
import { recordAsset } from '../src/main/projects/project-database';
import {
  findRetainedAssetSource,
  validateRetainedAssetSource,
} from '../src/main/recovery/retained-asset-source';
import { Library } from '../src/main/storage/library';
import { IPC_CHANNELS } from '../src/shared/desktop';
import type { Asset, SaveJob } from '../src/shared/models';

async function fixture(t: TestContext) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-retained-source-')),
  );
  const library = await Library.open(
    join(base, 'profile'),
    join(base, 'projects'),
  );
  t.after(async () => {
    await library.close();
    await rm(base, { recursive: true, force: true });
  });
  const snapshot = await library.projects.create('保留副本测试');
  const bytes = Buffer.from('完整素材副本\n');
  const asset: Asset = {
    id: randomUUID(),
    name: '分镜文本.txt',
    relativePath: `assets/text/${randomUUID()}.txt`,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    kind: 'text',
    usage: 'reference',
  };
  const job: SaveJob = {
    id: asset.id,
    projectId: snapshot.project.id,
    name: asset.name,
    resultKey: `reference:${randomUUID()}`,
    extension: 'txt',
    status: 'saved',
    size: asset.size,
    sha256: asset.sha256,
    kind: asset.kind,
    usage: 'reference',
    error: null,
    createdAt: new Date().toISOString(),
    outputRelativePath: asset.relativePath,
  };
  const database = await library.projects.databasePath(job.projectId);
  library.store.putProject(
    recordAsset(database, job.resultKey, asset, snapshot.project),
  );
  library.store.putJob(job);
  const ready = library.staging.path(job.id);
  await writeFile(ready, bytes);
  const target = join(
    library.store.root,
    snapshot.project.folder,
    asset.relativePath,
  );
  await mkdir(join(library.store.root, snapshot.project.folder, 'assets/text'));
  return { base, library, bytes, asset, job, database, ready, target };
}

test('retained source discovery reads metadata only; explicit health restore verifies exact content and keeps source/job', async (t) => {
  const f = await fixture(t);
  const candidate = await findRetainedAssetSource(
    f.library,
    f.job.projectId,
    f.asset.id,
  );
  assert.ok(candidate);
  assert.equal(candidate.path, f.ready);
  assert.equal(
    await validateRetainedAssetSource(f.library, candidate),
    f.ready,
  );
  await f.library.health.restore(f.job.projectId, f.asset.id, candidate.path);
  assert.deepEqual(await readFile(f.target), f.bytes);
  assert.deepEqual(await readFile(f.ready), f.bytes);
  assert.deepEqual(f.library.store.job(f.job.id), f.job);
  assert.equal(
    await findRetainedAssetSource(f.library, f.job.projectId, f.asset.id),
    null,
  );
});

test('same-size wrong retained bytes are only a candidate, never published without full SHA verification', async (t) => {
  const f = await fixture(t);
  const wrong = Buffer.from(f.bytes);
  wrong[0] = (wrong[0] ?? 0) ^ 1;
  await writeFile(f.ready, wrong);
  const candidate = await findRetainedAssetSource(
    f.library,
    f.job.projectId,
    f.asset.id,
  );
  assert.ok(
    candidate,
    'the prompt must not claim content was verified during discovery',
  );
  await assert.rejects(
    f.library.health.restore(f.job.projectId, f.asset.id, candidate.path),
    /内容不一致/,
  );
  await assert.rejects(access(f.target), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.ready), wrong);
});

test('a candidate requires the saved job to match every registered asset field and a missing destination', async (t) => {
  const f = await fixture(t);
  for (const patch of [
    { status: 'ready' },
    { projectId: randomUUID() },
    { name: '其他名称.txt' },
    { sha256: 'f'.repeat(64) },
    { size: f.job.size + 1 },
    { kind: 'image' },
    { usage: undefined },
    { outputRelativePath: 'assets/text/another.txt' },
  ] as Partial<SaveJob>[]) {
    f.library.store.putJob({ ...f.job, ...patch });
    assert.equal(
      await findRetainedAssetSource(f.library, f.job.projectId, f.asset.id),
      null,
    );
  }
  f.library.store.putJob(f.job);
  await writeFile(f.target, Buffer.alloc(f.asset.size));
  assert.equal(
    await findRetainedAssetSource(f.library, f.job.projectId, f.asset.id),
    null,
  );
  await unlink(f.target);
  await writeFile(f.ready, 'partial');
  assert.equal(
    await findRetainedAssetSource(f.library, f.job.projectId, f.asset.id),
    null,
  );
});

test('confirmation rejects source, directory, database, job and destination changes without deleting either copy', async (t) => {
  for (const change of [
    'source',
    'directory',
    'root',
    'database',
    'job',
    'target',
  ] as const) {
    await t.test(change, async (t) => {
      const f = await fixture(t);
      const candidate = await findRetainedAssetSource(
        f.library,
        f.job.projectId,
        f.asset.id,
      );
      assert.ok(candidate);
      if (change === 'source') {
        await rename(f.ready, `${f.ready}.original`);
        await writeFile(f.ready, f.bytes);
      } else if (change === 'directory') {
        await rename(
          f.library.staging.directory,
          `${f.library.staging.directory}.original`,
        );
        await mkdir(f.library.staging.directory);
        await writeFile(f.ready, f.bytes);
      } else if (change === 'database') {
        const bytes = await readFile(f.database);
        await rename(f.database, `${f.database}.original`);
        await writeFile(f.database, bytes);
      } else if (change === 'root') {
        await rename(f.library.store.root, `${f.library.store.root}.original`);
        await mkdir(f.library.store.root);
        await rename(
          join(`${f.library.store.root}.original`, f.job.projectId),
          join(f.library.store.root, f.job.projectId),
        );
      } else if (change === 'job') {
        f.library.store.putJob({ ...f.job, status: 'failed' });
      } else await writeFile(f.target, f.bytes);
      await assert.rejects(
        validateRetainedAssetSource(f.library, candidate),
        /已变化.*重新检查/,
      );
      assert.deepEqual(await readFile(f.ready), f.bytes);
    });
  }
});

test('linked retained files are not offered even when their bytes match', async (t) => {
  const f = await fixture(t);
  await rename(f.ready, `${f.ready}.original`);
  await symlink(`${f.ready}.original`, f.ready);
  assert.equal(
    await findRetainedAssetSource(f.library, f.job.projectId, f.asset.id),
    null,
  );
  assert.deepEqual(await readFile(`${f.ready}.original`), f.bytes);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('native recovery confirmation is explicit, serial, cancellation-aware and rechecks sender/source before restoration', async (t) => {
  const f = await fixture(t);
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const event = {} as IpcMainInvokeEvent;
  const window = { isDestroyed: () => false } as BrowserWindow;
  let trusted = true;
  let box = deferred<{ response: number }>();
  let opened = deferred<MessageBoxOptions>();
  let picker = deferred<{ canceled: boolean; filePaths: string[] }>();
  let pickerOpened = deferred<void>();
  let pickerCount = 0;
  let restoreEntered = deferred<void>();
  const realRestore = f.library.health.restore.bind(f.library.health);
  t.mock.method(
    f.library.health,
    'restore',
    (...args: Parameters<typeof realRestore>) => {
      restoreEntered.resolve();
      return realRestore(...args);
    },
  );
  const globals = globalThis as typeof globalThis & {
    retainedRecoveryElectron?: unknown;
  };
  globals.retainedRecoveryElectron = {
    dialog: {
      showMessageBox: (_window: unknown, options: MessageBoxOptions) => {
        opened.resolve(options);
        return box.promise;
      },
      showOpenDialog: () => {
        pickerCount++;
        pickerOpened.resolve();
        return picker.promise;
      },
    },
    ipcMain: {
      handle: (key: string, handler: Handler) => handlers.set(key, handler),
    },
  };
  const module = `data:text/javascript,${encodeURIComponent('export const {dialog,ipcMain}=globalThis.retainedRecoveryElectron;')}`;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === 'electron'
        ? { url: module, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
  try {
    const { registerRecoveryIpc } = await import(
      '../src/main/recovery/recovery-ipc'
    );
    registerRecoveryIpc(
      f.library,
      (request) => {
        if (!trusted || request !== event) throw new Error('Untrusted request');
        return window;
      },
      () => null,
    );
  } finally {
    hook.deregister();
    delete globals.retainedRecoveryElectron;
  }
  const restore = handlers.get(IPC_CHANNELS.restoreMissingAsset);
  const cancel = handlers.get(IPC_CHANNELS.cancelProjectHealth);
  assert.ok(restore && cancel);
  const start = () =>
    Promise.resolve(restore(event, f.job.projectId, f.asset.id));
  const next = () => {
    box = deferred();
    opened = deferred();
    picker = deferred();
    pickerOpened = deferred();
    restoreEntered = deferred();
  };
  const unchanged = async () => {
    await assert.rejects(access(f.target), { code: 'ENOENT' });
    assert.deepEqual(await readFile(f.ready), f.bytes);
    assert.deepEqual(f.library.store.job(f.job.id), f.job);
  };

  const cancelled = start();
  const options = await opened.promise;
  assert.deepEqual(options.buttons, ['验证并恢复', '选择其他原文件', '取消']);
  assert.equal(options.defaultId, 2);
  assert.equal(options.cancelId, 2);
  assert.match(options.message, /验证内容一致后恢复/);
  await assert.rejects(start(), /完成或取消当前/);
  box.resolve({ response: 2 });
  assert.equal(await cancelled, null);
  assert.equal(pickerCount, 0);
  await unchanged();

  next();
  const alternative = start();
  await opened.promise;
  box.resolve({ response: 1 });
  await pickerOpened.promise;
  await assert.rejects(start(), /完成或取消当前/);
  picker.resolve({ canceled: true, filePaths: [] });
  assert.equal(await alternative, null);
  await unchanged();

  next();
  const leaving = start();
  await opened.promise;
  await cancel(event);
  box.resolve({ response: 0 });
  assert.equal(await leaving, null);
  await unchanged();

  next();
  const latePicker = start();
  await opened.promise;
  box.resolve({ response: 1 });
  await pickerOpened.promise;
  await cancel(event);
  picker.resolve({ canceled: false, filePaths: [f.ready] });
  assert.equal(await latePicker, null);
  await unchanged();

  next();
  const replaced = start();
  await opened.promise;
  await rename(f.ready, `${f.ready}.original`);
  await writeFile(f.ready, f.bytes);
  box.resolve({ response: 0 });
  await assert.rejects(replaced, /已变化.*重新检查/);
  await unchanged();

  next();
  const revoked = start();
  await opened.promise;
  trusted = false;
  box.resolve({ response: 0 });
  await assert.rejects(revoked, /Untrusted/);
  trusted = true;
  await unchanged();

  for (const changed of ['job', 'asset'] as const) {
    next();
    const release = deferred<void>();
    const occupied = deferred<void>();
    const gate = f.library.gate.run(() => {
      occupied.resolve();
      return release.promise;
    });
    await occupied.promise;
    const queued = start();
    await opened.promise;
    box.resolve({ response: 0 });
    await restoreEntered.promise;
    const setAsset = (asset: Asset) => {
      const db = new DatabaseSync(f.database);
      try {
        db.prepare('UPDATE assets SET payload = ? WHERE id = ?').run(
          JSON.stringify(asset),
          f.asset.id,
        );
      } finally {
        db.close();
      }
    };
    if (changed === 'job')
      f.library.store.putJob({ ...f.job, status: 'failed' });
    else setAsset({ ...f.asset, name: '已改动的素材名' });
    release.resolve();
    await gate;
    await assert.rejects(queued, /已变化.*重新检查/);
    f.library.store.putJob(f.job);
    setAsset(f.asset);
    await unchanged();
  }

  next();
  f.library.store.putJob({ ...f.job, status: 'failed' });
  const noCandidate = start();
  await pickerOpened.promise;
  picker.resolve({ canceled: true, filePaths: [] });
  assert.equal(await noCandidate, null);
  f.library.store.putJob(f.job);
  await unchanged();

  next();
  const invalidPicker = start();
  await opened.promise;
  box.resolve({ response: 1 });
  await pickerOpened.promise;
  picker.resolve({ canceled: false, filePaths: [f.ready, f.ready] });
  await assert.rejects(invalidPicker, /请选择一个/);
  await unchanged();

  next();
  const unsafeDirectory = f.library.staging.directory;
  const originalDirectory = `${unsafeDirectory}.original`;
  await rename(unsafeDirectory, originalDirectory);
  await symlink(originalDirectory, unsafeDirectory, 'junction');
  assert.equal(
    await findRetainedAssetSource(f.library, f.job.projectId, f.asset.id),
    null,
    'unsafe internal staging must not be offered or block an external choice',
  );
  const external = start();
  await pickerOpened.promise;
  picker.resolve({
    canceled: false,
    filePaths: [join(originalDirectory, basename(f.ready))],
  });
  await external;
  assert.deepEqual(await readFile(f.target), f.bytes);
  await unlink(f.target);
  await unlink(unsafeDirectory);
  await rename(originalDirectory, unsafeDirectory);
  await unchanged();

  next();
  const confirmed = start();
  await opened.promise;
  box.resolve({ response: 0 });
  await confirmed;
  assert.deepEqual(await readFile(f.target), f.bytes);
  assert.deepEqual(await readFile(f.ready), f.bytes);
  assert.deepEqual(f.library.store.job(f.job.id), f.job);
});
