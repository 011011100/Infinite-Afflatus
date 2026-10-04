import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { Library } from '../src/main/storage/library';
import { IPC_CHANNELS } from '../src/shared/desktop';
import { DEFAULT_EXPORT_OPTIONS } from '../src/shared/export';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('export IPC cancels stale native selections and late starts, accepts fresh selections and rejects untrusted cancellation', {
  timeout: 5_000,
}, async () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const trusted = {} as IpcMainInvokeEvent;
  const window = {} as BrowserWindow;
  let choice = deferred<{ canceled: boolean; filePath: string }>();
  let version = 0;
  let starts = 0;
  let startPending: ReturnType<typeof deferred<object>> | null = null;
  let started = deferred<void>();
  const projectId = randomUUID();
  const cardId = randomUUID();
  const job = { id: 'test-export-job' };
  const library = {
    projects: { summary: () => ({ id: projectId, name: '测试导出' }) },
    exports: {
      get cancellationVersion() {
        return version;
      },
      cancelPreparation: async () => {
        version += 1;
      },
      start: async () => {
        starts += 1;
        started.resolve();
        return startPending ? startPending.promise : job;
      },
    },
  } as unknown as Library;
  const globals = globalThis as typeof globalThis & {
    exportIpcTestElectron?: unknown;
  };
  globals.exportIpcTestElectron = {
    app: { getPath: () => tmpdir() },
    dialog: { showSaveDialog: () => choice.promise },
    ipcMain: {
      handle: (channel: string, handler: Handler) =>
        handlers.set(channel, handler),
    },
    shell: {},
  };
  const module = `data:text/javascript,${encodeURIComponent('export const {app,dialog,ipcMain,shell}=globalThis.exportIpcTestElectron;')}`;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === 'electron'
        ? { url: module, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
  try {
    const { registerExportIpc } = await import('../src/main/export/export-ipc');
    registerExportIpc(library, (event) => {
      if (event !== trusted) throw new Error('Untrusted desktop request');
      return window;
    });
  } finally {
    hook.deregister();
    delete globals.exportIpcTestElectron;
  }
  const start = handlers.get(IPC_CHANNELS.startExport);
  const cancel = handlers.get(IPC_CHANNELS.cancelExportPreparation);
  assert.ok(start && cancel);
  const selection = () =>
    start(trusted, projectId, cardId, DEFAULT_EXPORT_OPTIONS);
  const selected = {
    canceled: false,
    filePath: join(tmpdir(), 'export-selection.mp4'),
  };

  const stale = selection();
  await cancel(trusted);
  choice.resolve(selected);
  assert.equal(await stale, null);
  assert.equal(
    starts,
    0,
    'a dialog opened before leave must never start an export',
  );

  choice = deferred();
  const fresh = selection();
  choice.resolve(selected);
  assert.equal(await fresh, job);
  assert.equal(starts, 1);
  const beforeUntrusted = version;
  assert.throws(() => cancel({} as IpcMainInvokeEvent), /Untrusted/);
  assert.equal(version, beforeUntrusted);

  choice = deferred();
  startPending = deferred();
  started = deferred();
  const late = selection();
  choice.resolve(selected);
  await started.promise;
  await cancel(trusted);
  startPending.reject(new DOMException('cancelled', 'AbortError'));
  assert.equal(
    await late,
    null,
    'leave cancellation must not surface as a late UI failure',
  );

  startPending = null;
  choice = deferred();
  const retry = selection();
  choice.resolve(selected);
  assert.equal(await retry, job);
  assert.equal(starts, 3);
});
