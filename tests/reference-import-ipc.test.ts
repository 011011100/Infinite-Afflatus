import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { ReferenceImportService } from '../src/main/generation/reference-import-service';
import type { Library } from '../src/main/storage/library';
import { IPC_CHANNELS } from '../src/shared/desktop';
import type { ReferenceImportResult } from '../src/shared/generation/draft';
import type { ReferenceImportProgress } from '../src/shared/generation/reference-import';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('reference IPC scopes progress/cancel/leave tokens to the trusted owner, validates UUIDs and ignores a late native selection', {
  timeout: 5000,
}, async () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const first = {} as IpcMainInvokeEvent;
  const second = {} as IpcMainInvokeEvent;
  const untrusted = {} as IpcMainInvokeEvent;
  const messages = new Map<number, ReferenceImportProgress[]>([
    [1, []],
    [2, []],
  ]);
  const windows = new Map(
    [
      [first, 1],
      [second, 2],
    ].map(([event, id]) => [
      event,
      {
        isDestroyed: () => false,
        webContents: {
          id,
          isDestroyed: () => false,
          send: (channel: string, progress: ReferenceImportProgress) => {
            assert.equal(channel, IPC_CHANNELS.referenceImportProgress);
            messages.get(id as number)?.push(progress);
          },
        },
      } as unknown as BrowserWindow,
    ]),
  );
  const projectId = randomUUID();
  let choices = 0;
  let choice = deferred<{ canceled: boolean; filePaths: string[] }>();
  let received = 0;
  let resumed = 0;
  const service = new ReferenceImportService(
    {
      acceptResult: async () => {
        received += 1;
        throw new Error(
          'No selected file should be ingested by this IPC scenario',
        );
      },
    },
    {
      pauseLocalReferences: () => ({
        idle: async () => undefined,
        resume: () => {
          resumed += 1;
        },
      }),
    },
  );
  const library = {
    referenceImports: service,
    projects: {
      summary: (id: string) => {
        assert.equal(id, projectId);
        return { id };
      },
    },
    saves: {
      idle: () => {
        throw new Error('Import IPC must not drain the project save queue');
      },
    },
  } as unknown as Library;
  const globals = globalThis as typeof globalThis & {
    referenceIpcElectron?: unknown;
  };
  globals.referenceIpcElectron = {
    ipcMain: {
      handle: (channel: string, handler: Handler) =>
        handlers.set(channel, handler),
    },
    dialog: {
      showOpenDialog: (
        _window: BrowserWindow,
        options: { title: string; properties: string[] },
      ) => {
        choices += 1;
        assert.equal(options.title, '添加参考素材');
        assert.deepEqual(options.properties, ['openFile', 'multiSelections']);
        return choice.promise;
      },
    },
  };
  const module = `data:text/javascript,${encodeURIComponent('export const {ipcMain,dialog}=globalThis.referenceIpcElectron;')}`;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === 'electron'
        ? { url: module, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
  try {
    const { registerGenerationIpc } = await import(
      '../src/main/generation/generation-ipc'
    );
    registerGenerationIpc(library, (event) => {
      const window = windows.get(event);
      if (!window) throw new Error('Untrusted desktop request');
      return window;
    });
  } finally {
    hook.deregister();
    delete globals.referenceIpcElectron;
  }
  const start = handlers.get(IPC_CHANNELS.importReferences);
  const cancel = handlers.get(IPC_CHANNELS.cancelReferenceImport);
  const prepare = handlers.get(IPC_CHANNELS.prepareReferenceImportsForLeave);
  const resume = handlers.get(IPC_CHANNELS.resumeReferenceSaves);
  assert.ok(start && cancel && prepare && resume);
  await assert.rejects(
    async () => start(untrusted, projectId, randomUUID()),
    /Untrusted/,
  );
  await assert.rejects(
    async () =>
      start(first, projectId, '--------bad-import-id----------------'),
    /无效/,
  );
  assert.equal(choices, 0);
  assert.throws(() => cancel(untrusted, randomUUID()), /Untrusted/);
  assert.throws(() => prepare(untrusted), /Untrusted/);
  assert.throws(() => resume(untrusted, randomUUID()), /Untrusted/);
  assert.throws(() => cancel(first, 'not-a-uuid'), /无效/);
  assert.throws(() => resume(first, 'not-a-uuid'), /无效/);
  const requestId = randomUUID();
  const pending = start(
    first,
    projectId,
    requestId,
  ) as Promise<ReferenceImportResult>;
  await cancel(second, requestId);
  assert.equal(messages.get(1)?.at(-1)?.phase, 'choosing');
  await cancel(first, requestId);
  assert.equal((await pending).cancelled, true);
  choice.resolve({ canceled: false, filePaths: ['must-not-open.txt'] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(received, 0);
  assert.equal(
    messages.get(2)?.length,
    0,
    'progress is never broadcast to another window',
  );
  assert.ok(
    messages
      .get(1)
      ?.every(
        (progress) =>
          progress.requestId === requestId && progress.projectId === projectId,
      ),
  );
  choice = deferred();
  const next = start(
    first,
    projectId,
    randomUUID(),
  ) as Promise<ReferenceImportResult>;
  choice.resolve({ canceled: false, filePaths: [] });
  assert.deepEqual(await next, {
    assetIds: [],
    errors: [],
    cancelled: false,
    cancelledCount: 0,
  });
  const token = await prepare(first);
  assert.equal(typeof token, 'string');
  assert.throws(() => resume(second, token), /其他窗口/);
  assert.equal(resumed, 0);
  resume(first, token);
  resume(first, token);
  assert.equal(resumed, 1);
  assert.equal(choices, 2);
});
