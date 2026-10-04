import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../src/shared/desktop';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class WindowFixture extends EventEmitter {
  readonly messages: { channel: string; token?: string }[] = [];
  readonly webContents;
  destroyed = false;
  shown = false;
  constructor(id: number) {
    super();
    this.webContents = {
      id,
      mainFrame: {},
      send: (channel: string, token?: string) =>
        this.messages.push({ channel, ...(token ? { token } : {}) }),
    };
  }
  isDestroyed() {
    return this.destroyed;
  }
  show() {
    this.shown = true;
  }
  focus() {}
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
  get window() {
    return this as unknown as BrowserWindow;
  }
  get event() {
    return {
      sender: this.webContents,
      senderFrame: this.webContents.mainFrame,
    } as unknown as IpcMainInvokeEvent;
  }
  get token() {
    const token = [...this.messages]
      .reverse()
      .find((entry) => entry.channel === IPC_CHANNELS.saveBeforeLeave)?.token;
    assert.ok(token);
    return token;
  }
}

test('native close waits for reference preparation, releases only failed-attempt leases and resumes a closed owner on reopening', async (t) => {
  type Handler = (
    event: IpcMainInvokeEvent,
    token: unknown,
    saved: unknown,
  ) => Promise<void>;
  const handlers = new Map<string, Handler>();
  let errorDialogs = 0;
  const globals = globalThis as typeof globalThis & {
    nativeImportLeaveElectron?: unknown;
  };
  globals.nativeImportLeaveElectron = {
    ipcMain: {
      handle: (channel: string, handler: Handler) =>
        handlers.set(channel, handler),
    },
    dialog: {
      showErrorBox: () => {
        errorDialogs++;
      },
    },
  };
  const module = `data:text/javascript,${encodeURIComponent('export const {ipcMain,dialog}=globalThis.nativeImportLeaveElectron;')}`;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === 'electron'
        ? { url: module, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
  const { SaveLifecycle } = await import('../src/main/desktop/save-lifecycle');
  hook.deregister();
  delete globals.nativeImportLeaveElectron;
  const pauses: {
    owner: number;
    ready: ReturnType<typeof deferred<string>>;
  }[] = [];
  const resumed: [number, string][] = [];
  const reopened: number[] = [];
  let current = new WindowFixture(11);
  const lifecycle = new SaveLifecycle(
    () => current.window,
    () => undefined,
    {
      prepareForLeave: (owner) => {
        const ready = deferred<string>();
        pauses.push({ owner, ready });
        return ready.promise;
      },
      resumeAfterLeave: (owner, token) => {
        resumed.push([owner, token]);
      },
      resumeOwner: (owner) => {
        reopened.push(owner);
      },
    },
  );
  const acknowledge = handlers.get(IPC_CHANNELS.saveBeforeLeaveResult);
  assert.ok(acknowledge);
  lifecycle.protect(current.window, () => false);
  let closed = false;
  const first = lifecycle.prepare().then((saved) => {
    closed = saved;
    return saved;
  });
  const earlyAck = acknowledge(current.event, current.token, true);
  await Promise.resolve();
  assert.equal(
    closed,
    false,
    'Renderer acknowledgement cannot bypass native preparation',
  );
  assert.equal(pauses.length, 1);
  pauses[0]?.ready.resolve('first-lease');
  await earlyAck;
  assert.equal(await first, true);
  assert.deepEqual(resumed, [], 'Successful close retains its lease');
  current.destroy();
  current = new WindowFixture(22);
  lifecycle.protect(current.window, () => false);
  assert.deepEqual(
    reopened,
    [11],
    'Only destroyed-window ownership resumes on macOS reopen',
  );

  // A timed-out native attempt must leave the window usable without waiting for
  // a stalled filesystem; its later cleanup cannot release the retry's lease.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timedOut = lifecycle.prepare();
  const staleToken = current.token;
  const earlyStaleAck = acknowledge(current.event, staleToken, true);
  const staleRejected = assert.rejects(
    earlyStaleAck,
    /Invalid save acknowledgement/,
  );
  t.mock.timers.tick(30_001);
  assert.equal(await timedOut, false);
  assert.equal(current.destroyed, false);
  assert.equal(errorDialogs, 1);
  assert.ok(
    current.messages.some(
      ({ channel }) => channel === IPC_CHANNELS.leaveCancelled,
    ),
  );
  const retry = lifecycle.prepare();
  assert.equal(
    lifecycle.prepare(),
    retry,
    'Repeated native close shares one attempt',
  );
  assert.equal(pauses.length, 3);
  pauses[1]?.ready.resolve('timed-out-lease');
  await staleRejected;
  await Promise.resolve();
  assert.deepEqual(resumed, [[22, 'timed-out-lease']]);
  await assert.rejects(
    acknowledge(
      { sender: {}, senderFrame: {} } as unknown as IpcMainInvokeEvent,
      current.token,
      true,
    ),
    /Untrusted/,
  );
  const retryAck = acknowledge(current.event, current.token, true);
  pauses[2]?.ready.resolve('retry-lease');
  await retryAck;
  assert.equal(await retry, true);
  assert.deepEqual(
    resumed,
    [[22, 'timed-out-lease']],
    'Old completion never resumes the current lease',
  );
  t.mock.timers.reset();
});
