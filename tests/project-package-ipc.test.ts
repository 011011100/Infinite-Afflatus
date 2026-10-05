import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { PackageRequests } from '../src/main/packages/package-requests';
import type { ProjectPackageService } from '../src/main/packages/project-package-service';
import type { Library } from '../src/main/storage/library';
import { IPC_CHANNELS } from '../src/shared/desktop';
import type { ProjectPackageProgress } from '../src/shared/project-package';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('project package IPC scopes progress, cancellation and leave pauses to validated requests and ignores late native selections', {
  timeout: 5000,
}, async () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const first = {} as IpcMainInvokeEvent;
  const second = {} as IpcMainInvokeEvent;
  const untrusted = {} as IpcMainInvokeEvent;
  const messages = new Map<number, ProjectPackageProgress[]>([
    [1, []],
    [2, []],
  ]);
  const windows = new Map(
    [
      [first, 1],
      [second, 2],
    ].map(([event, owner]) => [
      event,
      {
        isDestroyed: () => false,
        webContents: {
          id: owner,
          isDestroyed: () => false,
          send: (channel: string, progress: ProjectPackageProgress) => {
            assert.equal(channel, IPC_CHANNELS.projectPackageProgress);
            messages.get(owner as number)?.push(progress);
          },
        },
      } as unknown as BrowserWindow,
    ]),
  );
  const projectId = randomUUID();
  const info = { projectId, name: '原项目', bytes: 18, assetCount: 1 };
  const snapshot = { project: { id: randomUUID(), name: '独立项目' } };
  const calls: string[] = [];
  const packages = {
    inspect: async (id: string) => {
      assert.equal(id, projectId);
      calls.push('inspect');
      return info;
    },
    export: async (id: string, path: string) => {
      assert.equal(id, projectId);
      calls.push(`export:${path}`);
      return { ...info, path };
    },
    import: async (path: string) => {
      calls.push(`import:${path}`);
      return snapshot;
    },
    duplicate: async (id: string) => {
      assert.equal(id, projectId);
      calls.push('duplicate');
      return snapshot;
    },
    cancel: () => {},
  } as unknown as ProjectPackageService;
  const packageRequests = new PackageRequests(packages);
  let emitted = 0;
  const library = {
    packages,
    packageRequests,
    projects: {
      summary: (id: string) => {
        assert.equal(id, projectId);
        return { id, name: '原项目' };
      },
    },
    emit: () => {
      emitted++;
    },
  } as unknown as Library;
  let choices = 0;
  let openChoice = deferred<{ canceled: boolean; filePaths: string[] }>();
  let saveChoice = deferred<{ canceled: boolean; filePath?: string }>();
  const globals = globalThis as typeof globalThis & {
    packageIpcElectron?: unknown;
  };
  globals.packageIpcElectron = {
    ipcMain: {
      handle: (channel: string, handler: Handler) =>
        handlers.set(channel, handler),
    },
    app: { getPath: () => '/documents' },
    dialog: {
      showOpenDialog: (
        _window: BrowserWindow,
        options: { title: string; properties: string[] },
      ) => {
        choices++;
        assert.equal(options.title, '导入项目包');
        assert.deepEqual(options.properties, ['openFile']);
        return openChoice.promise;
      },
      showSaveDialog: (_window: BrowserWindow, options: { title: string }) => {
        choices++;
        assert.equal(options.title, '导出项目包');
        return saveChoice.promise;
      },
    },
  };
  const module = `data:text/javascript,${encodeURIComponent('export const {ipcMain,app,dialog}=globalThis.packageIpcElectron;')}`;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'electron'
        ? { url: module, shortCircuit: true }
        : next(specifier, context);
    },
  });
  try {
    const { registerPackageIpc } = await import(
      '../src/main/packages/package-ipc'
    );
    registerPackageIpc(library, (event) => {
      const window = windows.get(event);
      if (!window) throw new Error('Untrusted desktop request');
      return window;
    });
  } finally {
    hook.deregister();
    delete globals.packageIpcElectron;
  }
  const handle = (channel: string) => {
    const result = handlers.get(channel);
    assert.ok(result);
    return result;
  };
  const start = handle(IPC_CHANNELS.importProjectPackage);
  const save = handle(IPC_CHANNELS.exportProjectPackage);
  const cancel = handle(IPC_CHANNELS.cancelProjectPackage);
  const prepare = handle(IPC_CHANNELS.preparePackageOperationsForLeave);
  const resume = handle(IPC_CHANNELS.resumePackageOperations);
  for (const method of [start, save, cancel, prepare, resume])
    await assert.rejects(
      async () => method(untrusted, projectId, randomUUID()),
      /Untrusted/,
    );
  for (const invalid of [
    undefined,
    '',
    'not-a-request',
    '--------bad-id----------------------',
  ])
    await assert.rejects(async () => start(first, invalid), /无效/);
  assert.throws(() => cancel(first, 'bad'), /无效/);
  assert.throws(() => resume(first, 'bad'), /无效/);
  assert.equal(choices, 0);
  const request = randomUUID();
  const pending = start(first, request) as Promise<unknown>;
  await cancel(second, request);
  await cancel(first, randomUUID());
  assert.equal(messages.get(1)?.at(-1)?.phase, 'choosing');
  await cancel(first, request);
  assert.equal(await pending, null);
  openChoice.resolve({ canceled: false, filePaths: ['late.afflatus'] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
  assert.deepEqual(messages.get(2), []);
  assert.ok(
    messages
      .get(1)
      ?.every(
        (item) => item.requestId === request && item.operation === 'import',
      ),
  );

  const exportRequest = randomUUID();
  const exporting = save(first, projectId, exportRequest) as Promise<unknown>;
  await cancel(first);
  assert.equal(await exporting, null);
  saveChoice.resolve({ canceled: false, filePath: '/late.afflatus' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls,
    [],
    'Owner-wide leave cancellation covers both native chooser kinds',
  );
  const beforePause = choices;
  const token = await prepare(first);
  assert.equal(typeof token, 'string');
  assert.equal(await start(first, randomUUID()), null);
  assert.equal(choices, beforePause);
  assert.throws(() => resume(second, token), /其他窗口/);
  resume(first, token);
  resume(first, token);

  openChoice = deferred();
  const malformed = start(first, randomUUID()) as Promise<unknown>;
  openChoice.resolve({
    canceled: false,
    filePaths: ['a.afflatus', 'b.afflatus'],
  });
  await assert.rejects(malformed, /一个项目包/);
  assert.deepEqual(calls, []);
  saveChoice = deferred();
  const wrongExtension = save(
    first,
    projectId,
    randomUUID(),
  ) as Promise<unknown>;
  saveChoice.resolve({ canceled: false, filePath: '/wrong.zip' });
  await assert.rejects(wrongExtension, /扩展名/);
  assert.deepEqual(calls, []);

  assert.deepEqual(
    await handle(IPC_CHANNELS.inspectProjectPackage)(
      first,
      projectId,
      randomUUID(),
    ),
    info,
  );
  saveChoice = deferred();
  const saved = save(first, projectId, randomUUID()) as Promise<unknown>;
  saveChoice.resolve({ canceled: false, filePath: '/complete.afflatus' });
  assert.equal(await saved, '/complete.afflatus');
  openChoice = deferred();
  const imported = start(first, randomUUID()) as Promise<unknown>;
  openChoice.resolve({ canceled: false, filePaths: ['/complete.afflatus'] });
  assert.equal(await imported, snapshot);
  assert.equal(
    await handle(IPC_CHANNELS.duplicateProject)(first, projectId, randomUUID()),
    snapshot,
  );
  assert.deepEqual(calls, [
    'inspect',
    'export:/complete.afflatus',
    'import:/complete.afflatus',
    'duplicate',
  ]);
  assert.equal(
    emitted,
    2,
    'Only complete import and duplicate publish a library refresh',
  );
  await packageRequests.close();
});
