import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../src/shared/desktop';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
class WindowFixture extends EventEmitter {
  readonly messages: { channel: string; token?: string }[] = [];
  readonly webContents;
  destroyed = false;
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
  show() {}
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

test('native leave waits for package cleanup and reference preparation; failures and old timeouts release only their own leases', async (t) => {
  type Handler = (
    event: IpcMainInvokeEvent,
    token: unknown,
    saved: unknown,
  ) => Promise<void>;
  const handlers = new Map<string, Handler>();
  const globals = globalThis as typeof globalThis & {
    packageLeaveElectron?: unknown;
  };
  globals.packageLeaveElectron = {
    ipcMain: {
      handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    },
    dialog: { showErrorBox: () => {} },
  };
  const module = `data:text/javascript,${encodeURIComponent('export const {ipcMain,dialog}=globalThis.packageLeaveElectron;')}`;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'electron'
        ? { url: module, shortCircuit: true }
        : next(specifier, context);
    },
  });
  const { SaveLifecycle } = await import('../src/main/desktop/save-lifecycle');
  hook.deregister();
  delete globals.packageLeaveElectron;
  const pauses: {
    kind: string;
    owner: number;
    ready: ReturnType<typeof deferred<string>>;
  }[] = [];
  const released: string[] = [];
  const resumedOwners: string[] = [];
  const service = (kind: string) => ({
    prepareForLeave: (owner: number) => {
      const ready = deferred<string>();
      pauses.push({ kind, owner, ready });
      return ready.promise;
    },
    resumeAfterLeave: (owner: number, token: string) => {
      released.push(`${kind}:${owner}:${token}`);
    },
    resumeOwner: (owner: number) => {
      resumedOwners.push(`${kind}:${owner}`);
    },
  });
  let current = new WindowFixture(31);
  const lifecycle = new SaveLifecycle(
    () => current.window,
    () => {},
    service('reference'),
    service('package'),
  );
  const ack = handlers.get(IPC_CHANNELS.saveBeforeLeaveResult);
  assert.ok(ack);
  lifecycle.protect(current.window, () => false);
  let settled = false;
  const first = lifecycle.prepare().then((value) => {
    settled = true;
    return value;
  });
  assert.deepEqual(
    pauses.map(({ kind }) => kind),
    ['reference', 'package'],
    'Both services stop admission before awaiting either',
  );
  const early = ack(current.event, current.token, true);
  pauses[0]?.ready.resolve('reference-first');
  await Promise.resolve();
  assert.equal(
    settled,
    false,
    'An early renderer acknowledgement must still wait for package cleanup',
  );
  pauses[1]?.ready.resolve('package-first');
  await early;
  assert.equal(await first, true);
  assert.deepEqual(
    released,
    [],
    'Successful native close retains both admission leases',
  );
  current.destroy();
  current = new WindowFixture(32);
  lifecycle.protect(current.window, () => false);
  assert.deepEqual(resumedOwners, ['reference:31', 'package:31']);

  const failed = lifecycle.prepare();
  const failedAck = ack(current.event, current.token, true);
  pauses[2]?.ready.resolve('reference-failed');
  pauses[3]?.ready.reject(new Error('owned temporary cleanup failed'));
  await failedAck;
  assert.equal(await failed, false);
  assert.equal(current.destroyed, false);
  assert.deepEqual(
    released,
    ['reference:32:reference-failed'],
    'A failed package preparation must release the reference lease that did succeed',
  );
  assert.ok(
    current.messages.some(
      (item) => item.channel === IPC_CHANNELS.leaveCancelled,
    ),
  );

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timeout = lifecycle.prepare();
  const oldToken = current.token;
  const lateAck = assert.rejects(
    ack(current.event, oldToken, true),
    /Invalid save acknowledgement/,
  );
  t.mock.timers.tick(30_001);
  assert.equal(await timeout, false);
  const retry = lifecycle.prepare();
  assert.equal(lifecycle.prepare(), retry);
  pauses[4]?.ready.resolve('reference-timeout');
  pauses[5]?.ready.resolve('package-timeout');
  await lateAck;
  await Promise.resolve();
  assert.deepEqual(released, [
    'reference:32:reference-failed',
    'reference:32:reference-timeout',
    'package:32:package-timeout',
  ]);
  const successfulAck = ack(current.event, current.token, true);
  pauses[6]?.ready.resolve('reference-retry');
  pauses[7]?.ready.resolve('package-retry');
  await successfulAck;
  assert.equal(await retry, true);
  assert.deepEqual(
    released,
    [
      'reference:32:reference-failed',
      'reference:32:reference-timeout',
      'package:32:package-timeout',
    ],
    'Old cleanup must not unlock the new close attempt',
  );
  t.mock.timers.reset();
});
