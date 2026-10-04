import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { AppBackupService } from '../src/main/backups/app-backup-service';
import { IPC_CHANNELS } from '../src/shared/desktop';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('backup IPC requires the current trusted main frame and only opens verified service locations', async () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const opened: string[] = [];
  const calls: string[] = [];
  const trusted = {} as IpcMainInvokeEvent;
  let owner = {} as BrowserWindow;
  let location = deferred<string>();
  const globals = globalThis as typeof globalThis & {
    backupIpcElectron?: unknown;
  };
  globals.backupIpcElectron = {
    ipcMain: {
      handle: (channel: string, handler: Handler) =>
        handlers.set(channel, handler),
    },
    shell: {
      openPath: async (path: string) => {
        opened.push(path);
        return '';
      },
    },
  };
  const module = `data:text/javascript,${encodeURIComponent('export const {ipcMain,shell}=globalThis.backupIpcElectron;')}`;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'electron'
        ? { url: module, shortCircuit: true }
        : next(specifier, context);
    },
  });
  const service = {
    list: async () => {
      calls.push('list');
      return {
        directory: '/fixed/backups',
        backups: [],
        issues: [],
        recovery: null,
      };
    },
    create: async () => {
      calls.push('create');
      return {
        id: 'local-backup',
        createdAt: '2026-10-05T00:00:00.000Z',
        appVersion: 'test',
        root: '/fixed/projects',
        projectCount: 0,
        saveCount: 0,
        bytes: 8192,
        sha256: 'a'.repeat(64),
        restorable: true,
        reason: null,
      };
    },
    backupDirectory: async () => {
      calls.push('backup-location');
      return location.promise;
    },
    retainedDirectory: async () => {
      calls.push('retained-location');
      return '/fixed/retained';
    },
  } as Pick<
    AppBackupService,
    'list' | 'create' | 'backupDirectory' | 'retainedDirectory'
  >;
  try {
    const { registerAppBackupIpc } = await import(
      '../src/main/backups/app-backup-ipc'
    );
    registerAppBackupIpc(service, (event) => {
      if (event !== trusted) throw new Error('Untrusted desktop request');
      return owner;
    });
  } finally {
    hook.deregister();
    delete globals.backupIpcElectron;
  }
  const names = [
    'getAppBackups',
    'createAppBackup',
    'revealAppBackups',
    'revealRetainedAppData',
  ] as const;
  for (const name of names) {
    const handler = handlers.get(IPC_CHANNELS[name]);
    assert.ok(handler);
    await assert.rejects(
      Promise.resolve().then(() =>
        handler({} as IpcMainInvokeEvent, '/attacker'),
      ),
      /Untrusted/,
    );
  }
  assert.deepEqual(calls, []);
  await handlers.get(IPC_CHANNELS.getAppBackups)?.(trusted);
  await handlers.get(IPC_CHANNELS.createAppBackup)?.(trusted);
  assert.deepEqual(calls, ['list', 'create']);
  const reveal = handlers.get(IPC_CHANNELS.revealAppBackups);
  assert.ok(reveal);
  const waiting = reveal(trusted, '/attacker');
  owner = {} as BrowserWindow;
  location.resolve('/fixed/backups');
  await assert.rejects(Promise.resolve(waiting), /窗口已变化/);
  assert.deepEqual(opened, []);
  location = deferred();
  const valid = reveal(trusted, '/attacker');
  location.resolve('/fixed/backups');
  await valid;
  await handlers.get(IPC_CHANNELS.revealRetainedAppData)?.(
    trusted,
    '/attacker',
  );
  assert.deepEqual(opened, ['/fixed/backups', '/fixed/retained']);
  assert.ok(
    ![...handlers.keys()].some((channel) => channel.includes('restore')),
  );
});
