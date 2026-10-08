import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import test from 'node:test';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../src/shared/desktop';
import type {
  ArkGenerationJob,
  ArkGenerationPreview,
  ArkGenerationTarget,
} from '../src/shared/generation/ark-types';

test('Ark IPC binds previews to the current main frame and never forwards untrusted or malformed operations', async () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const globals = globalThis as typeof globalThis & {
    arkIpcElectron?: unknown;
  };
  globals.arkIpcElectron = {
    ipcMain: {
      handle: (channel: string, handler: Handler) =>
        handlers.set(channel, handler),
    },
  };
  const mock = `data:text/javascript,${encodeURIComponent('export const {ipcMain}=globalThis.arkIpcElectron;')}`;
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === 'electron'
        ? { url: mock, shortCircuit: true }
        : next(specifier, context);
    },
  });
  const sent: unknown[][] = [];
  const contents = [1, 2].map((id) =>
    Object.assign(new EventEmitter(), {
      id,
      isDestroyed: () => false,
      send: (...args: unknown[]) => sent.push(args),
    }),
  );
  const first = {} as IpcMainInvokeEvent;
  const second = {} as IpcMainInvokeEvent;
  const bad = {} as IpcMainInvokeEvent;
  const windows = new Map([
    [
      first,
      {
        webContents: contents[0],
        isDestroyed: () => false,
      } as unknown as BrowserWindow,
    ],
    [
      second,
      {
        webContents: contents[1],
        isDestroyed: () => false,
      } as unknown as BrowserWindow,
    ],
  ]);
  const target: ArkGenerationTarget = {
    projectId: randomUUID(),
    shotId: 'shot:one',
    groupId: 'group:one',
  };
  const tokens = new Map<string, string | number>();
  const submitted: string[] = [];
  const cancelled: string[] = [];
  const jobs: string[] = [];
  let changes: () => void = () => {};
  let saved = 0;
  let invalidateConfig = false;
  const config = {
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3' as const,
    hasKey: false,
    secureStorageAvailable: false,
    models: [],
  };
  const preview = (): ArkGenerationPreview => ({
    ...target,
    kind: 'video',
    modelId: 'ep-fixture',
    capability: 'seedance-2.0',
    prompt: 'fixture prompt',
    parameters: {
      model: 'seedance-2.0',
      ratio: 'adaptive',
      resolution: '720p',
      duration: 5,
      generateAudio: true,
    },
    references: [],
    token: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    transmissionNotice: 'fixture',
    costNotice: 'fixture',
    warnings: [],
  });
  const job = (): ArkGenerationJob => {
    const {
      token: _token,
      expiresAt: _expiresAt,
      transmissionNotice: _notice,
      costNotice: _cost,
      warnings: _warnings,
      ...request
    } = preview();
    return {
      ...request,
      id: randomUUID(),
      phase: 'queued',
      createdAt: '2026-10-08T00:00:00Z',
      updatedAt: '2026-10-08T00:00:00Z',
      locallyStopped: false,
      error: null,
    };
  };
  let makePreview = async () => preview();
  try {
    const { registerArkIpc } = await import('../src/main/generation/ark-ipc');
    registerArkIpc(
      {
        config: () => config,
        configure: (_input, assertCurrent) => {
          if (invalidateConfig)
            contents[0]?.emit(
              'did-start-navigation',
              {},
              'file:///reload',
              false,
              true,
            );
          assertCurrent?.();
          saved++;
          return config;
        },
        preview: async (owner) => {
          const value = await makePreview();
          tokens.set(value.token, owner);
          return value;
        },
        submit: async (owner, token) => {
          assert.equal(tokens.get(token), owner, 'one preview owner only');
          tokens.delete(token);
          submitted.push(token);
          return job();
        },
        cancelPreview: (owner, token) => {
          cancelled.push(String(owner));
          for (const [key, current] of tokens)
            if (current === owner && (!token || key === token))
              tokens.delete(key);
        },
        list: () => [],
        refresh: async (id) => {
          jobs.push(id);
          return job();
        },
        retryDownload: async (id) => {
          jobs.push(id);
          return job();
        },
        retrySave: async (id) => {
          jobs.push(id);
          return job();
        },
        stopLocal: async (id) => {
          jobs.push(id);
          return job();
        },
        cancelQueued: async (id) => {
          jobs.push(id);
          return job();
        },
        adopt: async () => {
          throw new Error('fixture adoption');
        },
        subscribe: (listener) => {
          changes = listener;
          return () => {};
        },
      },
      (event) => {
        const window = windows.get(event);
        if (!window) throw new Error('Untrusted desktop request');
        return window;
      },
      () => windows.get(first) ?? null,
    );
  } finally {
    hook.deregister();
    delete globals.arkIpcElectron;
  }
  const call = async (channel: string, event = first, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    assert.ok(handler);
    return handler(event, ...args);
  };
  for (const channel of handlers.keys())
    await assert.rejects(() => call(channel, bad), /Untrusted/);
  assert.equal(saved, 0);
  assert.deepEqual(submitted, []);
  await assert.rejects(
    () => call(IPC_CHANNELS.previewArkGeneration, first, null),
    /目标/,
  );
  await assert.rejects(
    () =>
      call(IPC_CHANNELS.previewArkGeneration, first, {
        ...target,
        projectId: '../outside',
      }),
    /项目/,
  );
  await assert.rejects(
    () =>
      call(IPC_CHANNELS.previewArkGeneration, first, {
        ...target,
        groupId: '../outside',
      }),
    /生成组/,
  );
  await assert.rejects(
    () => call(IPC_CHANNELS.submitArkGeneration, first, {}),
    /失效/,
  );
  await assert.rejects(
    () => call(IPC_CHANNELS.listArkJobs, first, target.projectId, {}),
    /生成组/,
  );
  for (const channel of [
    IPC_CHANNELS.refreshArkJob,
    IPC_CHANNELS.retryArkDownload,
    IPC_CHANNELS.retryArkSave,
    IPC_CHANNELS.stopArkPolling,
    IPC_CHANNELS.cancelArkQueued,
  ])
    await assert.rejects(() => call(channel, first, '../outside'), /标识/);
  await assert.rejects(
    () => call(IPC_CHANNELS.adoptArkJob, first, randomUUID(), -1),
    /版本/,
  );
  assert.deepEqual(jobs, []);
  const firstPreview = (await call(
    IPC_CHANNELS.previewArkGeneration,
    first,
    target,
  )) as ArkGenerationPreview;
  await assert.rejects(() =>
    call(IPC_CHANNELS.submitArkGeneration, second, firstPreview.token),
  );
  await call(IPC_CHANNELS.submitArkGeneration, first, firstPreview.token);
  await assert.rejects(() =>
    call(IPC_CHANNELS.submitArkGeneration, first, firstPreview.token),
  );
  assert.deepEqual(submitted, [firstPreview.token]);
  const old = (await call(
    IPC_CHANNELS.previewArkGeneration,
    first,
    target,
  )) as ArkGenerationPreview;
  contents[0]?.emit('did-start-navigation', {}, 'file:///reload', false, true);
  await assert.rejects(() =>
    call(IPC_CHANNELS.submitArkGeneration, first, old.token),
  );
  let release!: (value: ArkGenerationPreview) => void;
  makePreview = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = call(IPC_CHANNELS.previewArkGeneration, first, target);
  contents[0]?.emit('render-process-gone');
  const late = preview();
  release(late);
  await assert.rejects(() => pending, /窗口已变化/);
  assert.equal(tokens.has(late.token), false);
  invalidateConfig = true;
  await assert.rejects(
    () => call(IPC_CHANNELS.saveArkConfig, first, { models: [] }),
    /窗口已经变化/,
  );
  assert.equal(saved, 0);
  invalidateConfig = false;
  await call(IPC_CHANNELS.saveArkConfig, first, { models: [] });
  assert.equal(saved, 1);
  changes();
  assert.deepEqual(
    sent,
    [[IPC_CHANNELS.arkJobsChanged]],
    'notifications contain no key, prompt or signed URL',
  );
  assert.ok(cancelled.length >= 3);
});
