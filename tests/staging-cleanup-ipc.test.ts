import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../src/shared/desktop';
import type { StagingCleanupPreview } from '../src/shared/staging-cleanup';

test('staging cleanup IPC binds destructive confirmation to the trusted preview window and consumes it once', async () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const globals = globalThis as typeof globalThis & {
    stagingCleanupElectron?: unknown;
  };
  globals.stagingCleanupElectron = {
    ipcMain: {
      handle: (channel: string, handler: Handler) =>
        handlers.set(channel, handler),
    },
  };
  const module = `data:text/javascript,${encodeURIComponent('export const {ipcMain}=globalThis.stagingCleanupElectron;')}`;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === 'electron'
        ? { url: module, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
  const first = {} as IpcMainInvokeEvent;
  const second = {} as IpcMainInvokeEvent;
  const untrusted = {} as IpcMainInvokeEvent;
  const owners = new Map<IpcMainInvokeEvent, number>([
    [first, 1],
    [second, 2],
  ]);
  let inspected = 0;
  let cancelled = 0;
  const executed: string[] = [];
  const preview = (): StagingCleanupPreview => ({
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    files: [{ jobId: randomUUID(), name: 'unfinished.wav', bytes: 42 }],
    bytes: 42,
    retained: [],
  });
  let makePreview: () => Promise<StagingCleanupPreview> = async () => preview();
  try {
    const { registerStagingCleanupIpc } = await import(
      '../src/main/saving/staging-cleanup-ipc'
    );
    registerStagingCleanupIpc(
      {
        inspect: async () => {
          inspected += 1;
          return { items: [] };
        },
        preview: () => makePreview(),
        execute: async (token) => {
          executed.push(token);
          return { removedCount: 1, removedBytes: 42, retained: [] };
        },
        cancel: () => {
          cancelled += 1;
        },
      },
      (event) => {
        const owner = owners.get(event);
        if (!owner) throw new Error('Untrusted desktop request');
        return { webContents: { id: owner } } as BrowserWindow;
      },
    );
  } finally {
    hook.deregister();
    delete globals.stagingCleanupElectron;
  }
  const call = async (
    channel: string,
    event: IpcMainInvokeEvent,
    ...args: unknown[]
  ) => {
    const handler = handlers.get(channel);
    assert.ok(handler);
    return handler(event, ...args);
  };
  for (const channel of [
    IPC_CHANNELS.inspectStaging,
    IPC_CHANNELS.previewStagingCleanup,
    IPC_CHANNELS.executeStagingCleanup,
    IPC_CHANNELS.cancelStagingOperations,
  ])
    await assert.rejects(
      () => call(channel, untrusted, randomUUID()),
      /Untrusted/,
    );
  assert.equal(inspected, 0);
  assert.equal(cancelled, 0);
  assert.deepEqual(executed, []);
  await call(IPC_CHANNELS.inspectStaging, first);
  assert.equal(inspected, 1);
  const firstPreview = (await call(
    IPC_CHANNELS.previewStagingCleanup,
    first,
  )) as StagingCleanupPreview;
  for (const invalid of ['../staging', null, randomUUID()])
    await assert.rejects(
      () => call(IPC_CHANNELS.executeStagingCleanup, first, invalid),
      /预览已失效/,
    );
  await assert.rejects(
    () => call(IPC_CHANNELS.executeStagingCleanup, second, firstPreview.token),
    /预览已失效/,
  );
  await call(IPC_CHANNELS.executeStagingCleanup, first, firstPreview.token);
  await assert.rejects(
    () => call(IPC_CHANNELS.executeStagingCleanup, first, firstPreview.token),
    /预览已失效/,
  );
  assert.deepEqual(executed, [firstPreview.token]);
  const oldPreview = (await call(
    IPC_CHANNELS.previewStagingCleanup,
    first,
  )) as StagingCleanupPreview;
  const newPreview = (await call(
    IPC_CHANNELS.previewStagingCleanup,
    first,
  )) as StagingCleanupPreview;
  await assert.rejects(
    () => call(IPC_CHANNELS.executeStagingCleanup, first, oldPreview.token),
    /预览已失效/,
  );
  await call(IPC_CHANNELS.cancelStagingOperations, first);
  assert.equal(cancelled, 1);
  await assert.rejects(
    () => call(IPC_CHANNELS.executeStagingCleanup, first, newPreview.token),
    /预览已失效/,
  );
  let resolve!: (value: StagingCleanupPreview) => void;
  makePreview = () =>
    new Promise((done) => {
      resolve = done;
    });
  const latePreview = call(IPC_CHANNELS.previewStagingCleanup, first);
  owners.delete(first);
  resolve(preview());
  await assert.rejects(() => latePreview, /Untrusted/);
  assert.deepEqual(executed, [firstPreview.token]);
});
