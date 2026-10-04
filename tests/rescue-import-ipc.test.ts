import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type {
  BrowserWindow,
  IpcMainInvokeEvent,
  OpenDialogOptions,
} from 'electron';
import type { RescueImportService } from '../src/main/drafts/rescue-import-service';
import { IPC_CHANNELS } from '../src/shared/desktop';
import type { RescueImportPreview } from '../src/shared/rescue-import';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('rescue IPC binds native selection to the current window and rejects cancelled or late authority', async () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const trusted = {} as IpcMainInvokeEvent;
  const events = new EventEmitter();
  let destroyed = false;
  const window = Object.assign(events, {
    webContents: { id: 7 },
    isDestroyed: () => destroyed,
  }) as unknown as BrowserWindow;
  let currentWindow = window;
  let choice = deferred<{ canceled: boolean; filePaths: string[] }>();
  let preparation = deferred<RescueImportPreview>();
  const calls: { operation: string; value: unknown; owner: number }[] = [];
  const configs: OpenDialogOptions[] = [];
  const service: Pick<RescueImportService, 'prepare' | 'confirm' | 'clear'> = {
    prepare: (path, owner) => {
      calls.push({ operation: 'prepare', value: path, owner });
      return preparation.promise;
    },
    confirm: async (token, owner) => {
      calls.push({ operation: 'confirm', value: token, owner });
      return {
        projectId: 'original',
        kind: 'name',
        key: { sessionId: 'new', seq: 1 },
        duplicate: false,
      };
    },
    clear: (owner) => {
      calls.push({ operation: 'clear', value: null, owner });
    },
  };
  const globals = globalThis as typeof globalThis & {
    rescueIpcElectron?: unknown;
  };
  globals.rescueIpcElectron = {
    ipcMain: {
      handle: (name: string, handler: Handler) => handlers.set(name, handler),
    },
    dialog: {
      showOpenDialog: (owner: BrowserWindow, config: OpenDialogOptions) => {
        assert.equal(owner, window);
        configs.push(config);
        return choice.promise;
      },
    },
  };
  const shim = `data:text/javascript,${encodeURIComponent('export const {ipcMain,dialog}=globalThis.rescueIpcElectron;')}`;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'electron'
        ? { url: shim, shortCircuit: true }
        : next(specifier, context);
    },
  });
  try {
    const { registerRescueImportIpc } = await import(
      '../src/main/drafts/rescue-import-ipc'
    );
    registerRescueImportIpc(service, (event) => {
      if (event !== trusted) throw new Error('Untrusted desktop request');
      return currentWindow;
    });
  } finally {
    hook.deregister();
    delete globals.rescueIpcElectron;
  }
  const get = (name: keyof typeof IPC_CHANNELS) => {
    const handler = handlers.get(IPC_CHANNELS[name]);
    assert.ok(handler);
    return handler;
  };
  const choose = get('chooseRescueImport');
  const confirm = get('confirmRescueImport');
  const cancel = get('cancelRescueImport');
  for (const invoke of [choose, confirm, cancel])
    await assert.rejects(
      Promise.resolve().then(() =>
        invoke({} as IpcMainInvokeEvent, '/untrusted/path'),
      ),
      /Untrusted/,
    );
  assert.equal(calls.length, 0);
  for (const token of [undefined, {}, '../path', ''])
    assert.throws(() => confirm(trusted, token), /无效/);
  const cancelled = choose(trusted, '/renderer/cannot/choose');
  await assert.rejects(
    Promise.resolve().then(() => choose(trusted)),
    /完成或取消/,
  );
  cancel(trusted);
  choice.resolve({ canceled: false, filePaths: ['/native/late.json'] });
  assert.equal(await cancelled, null);
  assert.equal(calls.filter((c) => c.operation === 'prepare').length, 0);
  assert.deepEqual(configs[0]?.properties, ['openFile']);

  choice = deferred();
  const nativeCancelled = choose(trusted);
  choice.resolve({ canceled: true, filePaths: [] });
  assert.equal(await nativeCancelled, null);
  choice = deferred();
  const multiple = choose(trusted);
  choice.resolve({ canceled: false, filePaths: ['/one.json', '/two.json'] });
  await assert.rejects(Promise.resolve(multiple), /一次选择一个/);

  choice = deferred();
  const changed = choose(trusted);
  currentWindow = {} as BrowserWindow;
  choice.resolve({ canceled: false, filePaths: ['/native/rescue.json'] });
  await assert.rejects(Promise.resolve(changed), /窗口已变化/);
  currentWindow = window;

  choice = deferred();
  const checking = choose(trusted);
  choice.resolve({ canceled: false, filePaths: ['/native/rescue.json'] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), {
    operation: 'prepare',
    value: '/native/rescue.json',
    owner: 7,
  });
  cancel(trusted);
  preparation.resolve({ token: 'stale' } as RescueImportPreview);
  assert.equal(await checking, null);

  preparation = deferred();
  choice = deferred();
  const ready = choose(trusted, '/renderer/ignored.json');
  choice.resolve({ canceled: false, filePaths: ['/native/verified.json'] });
  preparation.resolve({ token: 'verified' } as RescueImportPreview);
  assert.deepEqual(await ready, { token: 'verified' });
  await confirm(trusted, 'verified');
  assert.deepEqual(calls.at(-1), {
    operation: 'confirm',
    value: 'verified',
    owner: 7,
  });

  choice = deferred();
  const closing = choose(trusted);
  destroyed = true;
  events.emit('closed');
  choice.resolve({ canceled: false, filePaths: ['/native/after-close.json'] });
  assert.equal(await closing, null);
  assert.equal(events.listenerCount('closed'), 0);
});
