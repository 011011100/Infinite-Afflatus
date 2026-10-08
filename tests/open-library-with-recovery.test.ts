import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import type { MessageBoxOptions } from 'electron';
import { RootRelocationService } from '../src/main/relocation/root-relocation-service';
import { Library } from '../src/main/storage/library';
import { LibraryOpenError } from '../src/main/storage/library-open-error';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('real startup entry exposes relocation only when eligible, preserves dialog order, and owns exit until library acquisition settles', async (t) => {
  const events = new EventEmitter();
  let stopped = deferred<void>();
  let quits = 0;
  const app = Object.assign(events, {
    getVersion: () => 'test',
    quit() {
      let prevented = false;
      events.emit('before-quit', {
        preventDefault() {
          prevented = true;
        },
      });
      if (!prevented) {
        quits++;
        stopped.resolve();
      }
    },
    exit() {
      assert.fail('unexpected forced startup exit');
    },
  });
  const boxes: MessageBoxOptions[] = [];
  let choose: (options: MessageBoxOptions) => Promise<number> = async (
    options,
  ) => options.cancelId ?? 0;
  let eligible = true;
  let confirms = 0;
  let closes = 0;
  let opens = 0;
  const failure = new LibraryOpenError(
    new Error('原目录不可用'),
    '/profile',
    '/original/projects',
    'projects',
  );
  let open: () => Promise<Library> = async () => {
    throw failure;
  };
  t.mock.method(Library, 'open', () => {
    opens++;
    return open();
  });
  t.mock.method(
    RootRelocationService.prototype,
    'available',
    async () => eligible,
  );
  t.mock.method(RootRelocationService.prototype, 'close', async () => {
    closes++;
  });
  t.mock.method(RootRelocationService.prototype, 'preview', async () => ({
    token: 'one-location',
    expiresAt: '2099-01-01T00:00:00Z',
    oldRoot: '/original/projects',
    newRoot: '/moved/projects',
    projects: [{ id: 'one', name: '原项目' }],
    pendingSaveCount: 2,
  }));
  t.mock.method(
    RootRelocationService.prototype,
    'confirm',
    async (token: string) => {
      assert.equal(token, 'one-location');
      confirms++;
      return { root: '/moved/projects', retainedDirectory: '/retained' };
    },
  );
  const globals = globalThis as typeof globalThis & {
    startupEntryElectron?: unknown;
  };
  globals.startupEntryElectron = {
    app,
    dialog: {
      showMessageBox: async (options: MessageBoxOptions) => {
        boxes.push(options);
        return { response: await choose(options), checkboxChecked: false };
      },
      showOpenDialog: async () => ({
        canceled: false,
        filePaths: ['/moved/projects'],
      }),
    },
    shell: { openPath: async () => '' },
  };
  const module = `data:text/javascript,${encodeURIComponent('export const {app,dialog,shell}=globalThis.startupEntryElectron; export const safeStorage=undefined;')}`;
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === 'electron'
        ? { url: module, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
  let run: typeof import('../src/main/startup/open-library-with-recovery').openLibraryWithRecovery;
  try {
    run = (await import('../src/main/startup/open-library-with-recovery'))
      .openLibraryWithRecovery;
  } finally {
    hook.deregister();
    delete globals.startupEntryElectron;
  }

  assert.equal(await run('/profile', '/unused-default'), null);
  assert.deepEqual(boxes[0]?.buttons, [
    '重试',
    '重新定位原项目目录',
    '查看应用数据位置',
    '检查本机备份',
    '查看原项目位置',
    '退出',
  ]);
  assert.equal(boxes[0]?.defaultId, 0);
  assert.equal(boxes[0]?.cancelId, 5);
  assert.equal(events.listenerCount('before-quit'), 0);
  assert.equal(opens, 1);
  assert.equal(confirms, 0);

  eligible = false;
  boxes.length = 0;
  assert.equal(await run('/profile', '/unused-default'), null);
  assert.deepEqual(boxes[0]?.buttons, [
    '重试',
    '查看应用数据位置',
    '检查本机备份',
    '查看原项目位置',
    '退出',
  ]);
  assert.equal(boxes[0]?.cancelId, 4);

  eligible = true;
  boxes.length = 0;
  let closed = false;
  const library = {
    close: async () => {
      closed = true;
    },
  } as unknown as Library;
  const opened = deferred<Library>();
  const started = deferred<void>();
  open = () => {
    started.resolve();
    return opened.promise;
  };
  const acquisition = run('/profile', '/unused-default');
  await started.promise;
  app.quit();
  assert.equal(quits, 0);
  opened.resolve(library);
  assert.equal(await acquisition, null);
  await stopped.promise;
  assert.equal(
    closed,
    true,
    'a library acquired after quit must be closed, never handed to the renderer',
  );
  assert.equal(boxes.length, 0);
  assert.equal(events.listenerCount('before-quit'), 0);

  closed = false;
  stopped = deferred();
  boxes.length = 0;
  const startCount = opens;
  open = async () => {
    if (opens === startCount + 1) throw failure;
    return library;
  };
  choose = async (options) => (options.title === '无法打开项目库' ? 1 : 0);
  assert.equal(await run('/profile', '/unused-default'), library);
  assert.equal(opens, startCount + 2);
  assert.equal(confirms, 1);
  assert.equal(closed, false);
  assert.deepEqual(
    boxes.map((box) => box.title),
    ['无法打开项目库', '确认重新定位原项目目录'],
  );
  assert.equal(events.listenerCount('before-quit'), 0);
  assert.ok(closes >= 4);
});
