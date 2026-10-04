import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type {
  BrowserWindow,
  IpcMainInvokeEvent,
  OpenDialogOptions,
} from 'electron';
import { MediaToolSettings } from '../src/main/media/media-tool-settings';
import { IPC_CHANNELS } from '../src/shared/desktop';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('media tool IPC validates owner and arguments, confines the native chooser and rechecks late selections before storing', {
  timeout: 5000,
}, async () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const trusted = {} as IpcMainInvokeEvent;
  const window = {} as BrowserWindow;
  let currentWindow = window;
  let choice = deferred<{ canceled: boolean; filePaths: string[] }>();
  let opened = deferred<void>();
  let chooserCalls = 0;
  const options: OpenDialogOptions[] = [];
  const values = new Map<string, unknown>();
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-media-ipc-')),
  );
  const candidate = join(base, 'ffprobe-fixture');
  await writeFile(candidate, 'executable fixture', { mode: 0o700 });
  const service = new MediaToolSettings(
    {
      get: <T>(key: string) =>
        values.has(key) ? (values.get(key) as T) : null,
      hasSetting: (key) => values.has(key),
      set: (key, value) => {
        values.set(key, value);
      },
    },
    {
      env: {},
      platform: 'linux',
      inspect: async (location) => ({
        ...location,
        status: 'available',
        version: 'fixture',
        detail: null,
      }),
    },
  );
  const globals = globalThis as typeof globalThis & {
    mediaToolsIpcElectron?: unknown;
  };
  globals.mediaToolsIpcElectron = {
    ipcMain: {
      handle: (channel: string, handler: Handler) =>
        handlers.set(channel, handler),
    },
    dialog: {
      showOpenDialog: (owner: BrowserWindow, config: OpenDialogOptions) => {
        assert.equal(owner, window);
        chooserCalls++;
        options.push(config);
        opened.resolve();
        return choice.promise;
      },
    },
  };
  const module = `data:text/javascript,${encodeURIComponent('export const {ipcMain,dialog}=globalThis.mediaToolsIpcElectron;')}`;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'electron'
        ? { url: module, shortCircuit: true }
        : next(specifier, context);
    },
  });
  try {
    const { registerMediaToolsIpc } = await import(
      '../src/main/media/media-tools-ipc'
    );
    registerMediaToolsIpc(service, (event) => {
      if (event !== trusted) throw new Error('Untrusted desktop request');
      return currentWindow;
    });
  } finally {
    hook.deregister();
    delete globals.mediaToolsIpcElectron;
  }
  const handler = (
    name: keyof Pick<
      typeof IPC_CHANNELS,
      | 'getMediaToolSettings'
      | 'checkMediaTools'
      | 'chooseMediaTool'
      | 'resetMediaTool'
    >,
  ) => {
    const invoke = handlers.get(IPC_CHANNELS[name]);
    assert.ok(invoke);
    return invoke;
  };
  const get = handler('getMediaToolSettings');
  const check = handler('checkMediaTools');
  const choose = handler('chooseMediaTool');
  const reset = handler('resetMediaTool');
  try {
    for (const invoke of [get, check, choose, reset])
      assert.throws(
        () => invoke({} as IpcMainInvokeEvent, 'ffmpeg'),
        /Untrusted/,
      );
    for (const invalid of [undefined, null, {}, '../ffmpeg', 'FFMPEG', 'all'])
      assert.throws(() => choose(trusted, invalid), /无效/);
    assert.throws(() => reset(trusted, 'not-a-tool'), /无效/);
    assert.equal(chooserCalls, 0);
    const cancelled = choose(trusted, 'ffmpeg');
    await opened.promise;
    choice.resolve({ canceled: true, filePaths: [] });
    assert.equal(await cancelled, null);
    assert.equal(values.size, 0);
    assert.equal(options[0]?.title, '选择 FFmpeg 可执行文件');
    assert.deepEqual(options[0]?.properties, ['openFile']);

    choice = deferred();
    opened = deferred();
    const selection = choose(trusted, 'ffprobe');
    await opened.promise;
    choice.resolve({ canceled: false, filePaths: [candidate] });
    const selected = (await selection) as Awaited<
      ReturnType<MediaToolSettings['choose']>
    >;
    assert.equal(selected?.settings.locations.ffprobe.command, candidate);
    assert.equal(selected?.settings.locations.ffmpeg.source, 'path');
    assert.equal(options[1]?.title, '选择 FFprobe 可执行文件');
    const previous = values.get('mediaToolSettings');

    choice = deferred();
    opened = deferred();
    const stale = choose(trusted, 'ffmpeg');
    const rejected = assert.rejects(Promise.resolve(stale), /窗口已变化/);
    await opened.promise;
    currentWindow = {} as BrowserWindow;
    choice.resolve({ canceled: false, filePaths: [candidate] });
    await rejected;
    assert.deepEqual(values.get('mediaToolSettings'), previous);
    currentWindow = window;

    choice = deferred();
    opened = deferred();
    const multiple = choose(trusted, 'ffmpeg');
    const multipleRejected = assert.rejects(
      Promise.resolve(multiple),
      /请选择一个/,
    );
    await opened.promise;
    choice.resolve({ canceled: false, filePaths: [candidate, candidate] });
    await multipleRejected;
    const report = (await check(trusted)) as Awaited<
      ReturnType<MediaToolSettings['check']>
    >;
    assert.equal(report.tools.length, 2);
    const resetResult = (await reset(trusted, 'ffprobe')) as Awaited<
      ReturnType<MediaToolSettings['reset']>
    >;
    assert.equal(resetResult.settings.paths?.ffprobe, null);
    values.set('mediaToolSettings', { version: 99 });
    assert.equal(
      (get(trusted) as ReturnType<MediaToolSettings['state']>).paths,
      null,
    );
    assert.throws(() => check(trusted), /损坏/);
    await reset(trusted, 'all');
    assert.equal(
      (get(trusted) as ReturnType<MediaToolSettings['state']>).error,
      null,
    );

    choice = deferred();
    opened = deferred();
    const last = choose(trusted, 'ffmpeg');
    const lastRejected = assert.rejects(Promise.resolve(last), /已关闭/);
    await opened.promise;
    const beforeClose = values.get('mediaToolSettings');
    await service.close();
    await lastRejected;
    choice.resolve({ canceled: false, filePaths: [candidate] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(values.get('mediaToolSettings'), beforeClose);
  } finally {
    await service.close();
    await rm(base, { recursive: true, force: true });
  }
});
