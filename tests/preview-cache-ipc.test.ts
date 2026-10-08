import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { WriteGate } from '../src/main/storage/write-gate';
import { IPC_CHANNELS } from '../src/shared/desktop';
import type { PreviewCacheCleanupPreview } from '../src/shared/preview-cache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('cache IPC consumes window-bound tokens and rejects late, cancelled, replaced and navigated previews', async () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const globals = globalThis as typeof globalThis & {
    previewCacheElectron?: unknown;
  };
  globals.previewCacheElectron = {
    ipcMain: {
      handle: (name: string, handler: Handler) => handlers.set(name, handler),
    },
  };
  const mock = `data:text/javascript,${encodeURIComponent('export const {ipcMain}=globalThis.previewCacheElectron;')}`;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'electron'
        ? { url: mock, shortCircuit: true }
        : next(specifier, context);
    },
  });
  const first = {} as IpcMainInvokeEvent;
  const second = {} as IpcMainInvokeEvent;
  const untrusted = {} as IpcMainInvokeEvent;
  const contents = [1, 2].map((id) =>
    Object.assign(new EventEmitter(), { id }),
  );
  const windows = new Map<IpcMainInvokeEvent, BrowserWindow>([
    [first, { webContents: contents[0] } as BrowserWindow],
    [second, { webContents: contents[1] } as BrowserWindow],
  ]);
  const trusted = (event: IpcMainInvokeEvent) => {
    const window = windows.get(event);
    if (!window) throw new Error('Untrusted request');
    return window;
  };
  const preview = (): PreviewCacheCleanupPreview => ({
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    files: [],
    bytes: 10,
    retained: [],
    incomplete: false,
  });
  let makePreview = async () => preview();
  let inspections = 0;
  let cancelled = 0;
  const executed: string[] = [];
  try {
    const { registerPreviewCacheIpc } = await import(
      '../src/main/media/preview-cache-ipc'
    );
    registerPreviewCacheIpc(
      {
        inspect: async () => {
          inspections++;
          return {
            items: [],
            bytes: 0,
            eligibleCount: 0,
            eligibleBytes: 0,
            incomplete: false,
          };
        },
        preview: () => makePreview(),
        execute: async (token) => {
          executed.push(token);
          return {
            removedCount: 1,
            removedBytes: 10,
            retained: [],
            cancelled: false,
          };
        },
        cancel: () => {
          cancelled++;
        },
      },
      trusted,
    );
  } finally {
    hook.deregister();
    delete globals.previewCacheElectron;
  }
  const call = async (channel: string, event = first, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler);
    return handler(event, ...args);
  };
  for (const channel of [
    IPC_CHANNELS.inspectPreviewCache,
    IPC_CHANNELS.previewCacheCleanup,
    IPC_CHANNELS.executePreviewCacheCleanup,
    IPC_CHANNELS.cancelPreviewCacheOperations,
  ])
    await assert.rejects(
      () => call(channel, untrusted, randomUUID()),
      /Untrusted/,
    );
  assert.equal(cancelled, 0);
  await call(IPC_CHANNELS.inspectPreviewCache);
  assert.equal(inspections, 1);
  const valid = (await call(
    IPC_CHANNELS.previewCacheCleanup,
  )) as PreviewCacheCleanupPreview;
  await assert.rejects(
    () => call(IPC_CHANNELS.executePreviewCacheCleanup, second, valid.token),
    /预览已失效/,
  );
  for (const invalid of [null, '../cache', randomUUID()])
    await assert.rejects(
      () => call(IPC_CHANNELS.executePreviewCacheCleanup, first, invalid),
      /预览已失效/,
    );
  await call(IPC_CHANNELS.executePreviewCacheCleanup, first, valid.token);
  await assert.rejects(
    () => call(IPC_CHANNELS.executePreviewCacheCleanup, first, valid.token),
    /预览已失效/,
  );
  const old = (await call(
    IPC_CHANNELS.previewCacheCleanup,
  )) as PreviewCacheCleanupPreview;
  const current = (await call(
    IPC_CHANNELS.previewCacheCleanup,
  )) as PreviewCacheCleanupPreview;
  await assert.rejects(
    () => call(IPC_CHANNELS.executePreviewCacheCleanup, first, old.token),
    /预览已失效/,
  );
  contents[0]?.emit(
    'did-start-navigation',
    {},
    'file:///index.html',
    false,
    true,
  );
  await assert.rejects(
    () => call(IPC_CHANNELS.executePreviewCacheCleanup, first, current.token),
    /预览已失效/,
  );
  const late = deferred<PreviewCacheCleanupPreview>();
  makePreview = () => late.promise;
  const pending = call(IPC_CHANNELS.previewCacheCleanup);
  await call(IPC_CHANNELS.cancelPreviewCacheOperations);
  const lateValue = preview();
  late.resolve(lateValue);
  await assert.rejects(() => pending, /预览已失效/);
  await assert.rejects(
    () => call(IPC_CHANNELS.executePreviewCacheCleanup, first, lateValue.token),
    /预览已失效/,
  );
  const older = deferred<PreviewCacheCleanupPreview>();
  const newer = deferred<PreviewCacheCleanupPreview>();
  const queue = [older, newer];
  makePreview = () => {
    const item = queue.shift();
    assert.ok(item);
    return item.promise;
  };
  const a = call(IPC_CHANNELS.previewCacheCleanup);
  const b = call(IPC_CHANNELS.previewCacheCleanup);
  const latest = preview();
  newer.resolve(latest);
  await b;
  older.resolve(preview());
  await assert.rejects(() => a, /预览已失效/);
  await call(IPC_CHANNELS.executePreviewCacheCleanup, first, latest.token);
  makePreview = async () => preview();
  const destroyed = (await call(
    IPC_CHANNELS.previewCacheCleanup,
  )) as PreviewCacheCleanupPreview;
  contents[0]?.emit('destroyed');
  await assert.rejects(
    () => call(IPC_CHANNELS.executePreviewCacheCleanup, first, destroyed.token),
    /预览已失效/,
  );
  assert.deepEqual(executed, [valid.token, latest.token]);
});

test('editor proxy leases are serialized with cleanup, owner-bound and released on renderer lifetime end', async () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const globals = globalThis as typeof globalThis & {
    proxyUsageElectron?: unknown;
  };
  globals.proxyUsageElectron = {
    ipcMain: {
      handle: (name: string, handler: Handler) => handlers.set(name, handler),
    },
  };
  const mock = `data:text/javascript,${encodeURIComponent('export const {ipcMain}=globalThis.proxyUsageElectron;')}`;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'electron'
        ? { url: mock, shortCircuit: true }
        : next(specifier, context);
    },
  });
  const first = {} as IpcMainInvokeEvent;
  const second = {} as IpcMainInvokeEvent;
  const contents = [1, 2].map((id) =>
    Object.assign(new EventEmitter(), { id }),
  );
  const windows = new Map<IpcMainInvokeEvent, BrowserWindow>([
    [first, { webContents: contents[0] } as BrowserWindow],
    [second, { webContents: contents[1] } as BrowserWindow],
  ]);
  const gate = new WriteGate();
  let protectedCount = 0;
  let releaseCount = 0;
  try {
    const { registerProxyUsageIpc } = await import(
      '../src/main/media/proxy-usage-ipc'
    );
    registerProxyUsageIpc(
      {
        protect: (_project, ids) => {
          assert.equal(ids.length, 1);
          protectedCount++;
          return () => {
            releaseCount++;
          };
        },
      },
      gate,
      (event) => {
        const window = windows.get(event);
        if (!window) throw new Error('Untrusted request');
        return window;
      },
    );
  } finally {
    hook.deregister();
    delete globals.proxyUsageElectron;
  }
  const call = async (channel: string, event = first, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler);
    return handler(event, ...args);
  };
  const project = randomUUID();
  const asset = randomUUID();
  for (const value of [null, [], ['bad'], new Array(10_001).fill(asset)])
    await assert.rejects(
      () => call(IPC_CHANNELS.acquireProxyUsage, first, project, value),
      /无效/,
    );
  await assert.rejects(
    () =>
      call(IPC_CHANNELS.acquireProxyUsage, {} as IpcMainInvokeEvent, project, [
        asset,
      ]),
    /Untrusted/,
  );
  const barrier = deferred<void>();
  const cleanup = gate.run(() => barrier.promise);
  const pending = call(IPC_CHANNELS.acquireProxyUsage, first, project, [
    asset,
    asset,
  ]);
  assert.equal(protectedCount, 0);
  barrier.resolve();
  await cleanup;
  const token = await pending;
  assert.equal(protectedCount, 1);
  await assert.rejects(
    () => call(IPC_CHANNELS.releaseProxyUsage, second, token),
    /不属于/,
  );
  await call(IPC_CHANNELS.releaseProxyUsage, first, token);
  await call(IPC_CHANNELS.releaseProxyUsage, first, token);
  assert.equal(releaseCount, 1);
  await call(IPC_CHANNELS.acquireProxyUsage, first, project, [asset]);
  contents[0]?.emit('render-process-gone');
  assert.equal(releaseCount, 2);
  await call(IPC_CHANNELS.acquireProxyUsage, first, project, [asset]);
  contents[0]?.emit('did-start-navigation', {}, 'file:///reload', false, true);
  assert.equal(releaseCount, 3);
  const waiting = deferred<void>();
  const held = gate.run(() => waiting.promise);
  const late = call(IPC_CHANNELS.acquireProxyUsage, first, project, [asset]);
  contents[0]?.emit('destroyed');
  waiting.resolve();
  await held;
  await assert.rejects(() => late, /窗口已变化/);
  assert.equal(protectedCount, 3);
  await gate.block();
  await assert.rejects(
    () => call(IPC_CHANNELS.acquireProxyUsage, first, project, [asset]),
    /迁移/,
  );
  gate.release();
});
