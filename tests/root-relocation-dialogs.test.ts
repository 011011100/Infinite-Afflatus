import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MessageBoxOptions, OpenDialogOptions } from 'electron';
import { relocateRootFromDialogs } from '../src/main/startup/root-relocation-dialogs';
import { runStartupRecovery } from '../src/main/startup/startup-recovery';

type Relocation = Parameters<typeof relocateRootFromDialogs>[0];
type Preview = Awaited<ReturnType<Relocation['preview']>>;
const preview: Preview = {
  token: 'checked-location',
  expiresAt: '2099-01-01T00:00:00.000Z',
  oldRoot: '/original/projects',
  newRoot: '/renamed/projects',
  projects: [
    { id: 'project-one', name: '原项目一' },
    { id: 'project-two', name: '原项目二' },
  ],
  pendingSaveCount: 3,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const events: string[] = [];
  const boxes: MessageBoxOptions[] = [];
  const pickers: OpenDialogOptions[] = [];
  const relocation: Relocation = {
    available: async () => true,
    preview: async (path) => {
      events.push(`preview:${path}`);
      return preview;
    },
    confirm: async (token) => {
      events.push(`confirm:${token}`);
      return {
        root: preview.newRoot,
        retainedDirectory: '/profile/retained/original',
      };
    },
    cancel: () => {
      events.push('cancel');
    },
  };
  const dialogs = {
    showOpenDialog: async (options: OpenDialogOptions) => {
      pickers.push(options);
      return { canceled: false, filePaths: [preview.newRoot] };
    },
    showMessageBox: async (options: MessageBoxOptions) => {
      boxes.push(options);
      return { response: 0, checkboxChecked: false };
    },
  };
  return { events, boxes, pickers, relocation, dialogs };
}

test('root relocation uses one existing directory, previews the full scope and confirms only the checked token', async () => {
  const f = fixture();
  assert.equal(await relocateRootFromDialogs(f.relocation, f.dialogs), true);
  assert.deepEqual(f.pickers[0]?.properties, ['openDirectory']);
  assert.deepEqual(f.events, [
    'preview:/renamed/projects',
    'confirm:checked-location',
    'cancel',
  ]);
  assert.equal(
    f.boxes.length,
    1,
    'success returns to the open loop, without a second success dialog',
  );
  assert.equal(f.boxes[0]?.defaultId, 1);
  assert.equal(f.boxes[0]?.cancelId, 1);
  assert.deepEqual(f.boxes[0]?.buttons, ['确认位置并重新打开', '取消']);
  for (const text of [
    '/original/projects',
    '/renamed/projects',
    '原项目一',
    '原项目二',
    '3 个待保存任务',
    '不复制、移动或删除',
    '不代表所有素材内容完好',
  ])
    assert.ok(f.boxes[0]?.detail?.includes(text), text);
});

test('picker/preview cancellation, unavailable eligibility and malformed selections never confirm or open storage', async () => {
  const picker = fixture();
  picker.dialogs.showOpenDialog = async () => ({
    canceled: true,
    filePaths: [],
  });
  assert.equal(
    await relocateRootFromDialogs(picker.relocation, picker.dialogs),
    false,
  );
  assert.deepEqual(picker.events, ['cancel']);
  const confirmation = fixture();
  confirmation.dialogs.showMessageBox = async () => ({
    response: 1,
    checkboxChecked: false,
  });
  assert.equal(
    await relocateRootFromDialogs(
      confirmation.relocation,
      confirmation.dialogs,
    ),
    false,
  );
  assert.deepEqual(confirmation.events, [
    'preview:/renamed/projects',
    'cancel',
  ]);
  const unavailable = fixture();
  unavailable.relocation.available = async () => false;
  await assert.rejects(
    relocateRootFromDialogs(unavailable.relocation, unavailable.dialogs),
    /不满足/,
  );
  assert.deepEqual(unavailable.pickers, []);
  for (const filePaths of [[], ['', 'second'], ['one', 'two'], ['']]) {
    const invalid = fixture();
    invalid.dialogs.showOpenDialog = async () => ({
      canceled: false,
      filePaths,
    });
    await assert.rejects(
      relocateRootFromDialogs(invalid.relocation, invalid.dialogs),
      /请选择一个/,
    );
    assert.deepEqual(invalid.events, ['cancel']);
  }
});

test('expired or failed previews and failed publication do not show success or retry opening a library', async () => {
  const expired = fixture();
  expired.relocation.preview = async () => ({
    ...preview,
    expiresAt: '2000-01-01T00:00:00Z',
  });
  await assert.rejects(
    relocateRootFromDialogs(expired.relocation, expired.dialogs),
    /已过期/,
  );
  assert.deepEqual(expired.events, ['cancel']);
  const invalid = fixture();
  invalid.relocation.preview = async () => {
    throw new Error('不是原目录');
  };
  await assert.rejects(
    relocateRootFromDialogs(invalid.relocation, invalid.dialogs),
    /不是原目录/,
  );
  assert.equal(invalid.boxes.length, 0);
  const failed = fixture();
  failed.relocation.confirm = async () => {
    throw new Error('原目录已变化');
  };
  await assert.rejects(
    relocateRootFromDialogs(failed.relocation, failed.dialogs),
    /原目录已变化/,
  );
  assert.equal(failed.boxes.length, 1);
});

test('shutdown invalidates late picker, preview and confirmation replies without starting another storage action', async () => {
  for (const phase of ['picker', 'preview', 'confirmation'] as const) {
    const f = fixture();
    const controller = new AbortController();
    const entered = deferred<void>();
    const release = deferred<void>();
    if (phase === 'picker')
      f.dialogs.showOpenDialog = async () => {
        entered.resolve();
        await release.promise;
        return { canceled: false, filePaths: [preview.newRoot] };
      };
    if (phase === 'preview')
      f.relocation.preview = async () => {
        entered.resolve();
        await release.promise;
        return preview;
      };
    if (phase === 'confirmation')
      f.dialogs.showMessageBox = async () => {
        entered.resolve();
        await release.promise;
        return { response: 0, checkboxChecked: false };
      };
    const operation = relocateRootFromDialogs(
      f.relocation,
      f.dialogs,
      controller.signal,
    );
    await entered.promise;
    controller.abort();
    release.resolve();
    assert.equal(await operation, false, phase);
    assert.equal(
      f.events.some((event) => event.startsWith('confirm:')),
      false,
      phase,
    );
    if (phase === 'picker')
      assert.equal(
        f.events.some((event) => event.startsWith('preview:')),
        false,
      );
  }
});

test('an already confirmed publication finishes, but an exit request prevents subsequently opening a library', async () => {
  const f = fixture();
  const controller = new AbortController();
  const entered = deferred<void>();
  const release = deferred<void>();
  let completed = false;
  f.relocation.confirm = async () => {
    entered.resolve();
    await release.promise;
    completed = true;
    return { root: preview.newRoot, retainedDirectory: '/kept' };
  };
  const operation = relocateRootFromDialogs(
    f.relocation,
    f.dialogs,
    controller.signal,
  );
  await entered.promise;
  controller.abort();
  assert.equal(completed, false);
  release.resolve();
  assert.equal(await operation, false);
  assert.equal(completed, true);
});

test('the startup loop keeps cancellations and errors on the original failure; only successful relocation opens again', async () => {
  let opened = 0;
  let relocations = 0;
  const messages: (string | null)[] = [];
  const result = await runStartupRecovery(
    async () => {
      if (++opened === 1) throw new Error('原目录离线');
      return { originalProject: '仍是原项目' };
    },
    async (_failure, error) => {
      assert.equal(opened, 1, 'cancel/failure cannot open an empty fallback');
      messages.push(error);
      return 'relocate-root';
    },
    async () => assert.fail('no reveal requested'),
    undefined,
    async () => {
      if (++relocations === 1) return false;
      if (relocations === 2) throw new Error('不是原目录');
      return true;
    },
  );
  assert.deepEqual(result, { originalProject: '仍是原项目' });
  assert.equal(opened, 2);
  assert.deepEqual(messages, [null, null, '原目录重新定位未完成：不是原目录']);
});
