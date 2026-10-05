import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  PackageCancelledError,
  type PackageProgress,
} from '../src/main/packages/package-progress';
import { PackageRequests } from '../src/main/packages/package-requests';
import type { ProjectPackageProgress } from '../src/shared/project-package';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const base: PackageProgress = {
  phase: 'copying',
  completedBytes: 0,
  totalBytes: 1000,
  completedFiles: 0,
  totalFiles: 1,
  fileName: 'synthetic.txt',
  canCancel: true,
};

test('chooser cancellation releases admission immediately; late resolved or rejected choices never start writes', async () => {
  for (const lateReject of [false, true]) {
    const requests = new PackageRequests({ cancel() {} });
    const choice = deferred<boolean>();
    let starts = 0;
    const events: ProjectPackageProgress[] = [];
    const id = randomUUID();
    const pending = requests.run(
      1,
      id,
      'import',
      null,
      () => choice.promise,
      async () => ++starts,
      (value) => events.push(value),
    );
    await tick();
    await requests.cancel(1, id);
    assert.equal(await pending, null);
    assert.equal(starts, 0);
    assert.deepEqual(
      events.map((value) => value.phase),
      ['choosing', 'cancelling', 'cancelled'],
    );
    assert.equal(
      await requests.run(
        1,
        randomUUID(),
        'inspect',
        'project',
        async () => true,
        async () => 42,
      ),
      42,
    );
    if (lateReject) choice.reject(new Error('late native chooser rejection'));
    else choice.resolve(true);
    await tick();
    assert.equal(starts, 0);
    await requests.close();
  }
});

test('requests register before observers, reject concurrent work, and cancellation cannot target another owner or request', async () => {
  const requests = new PackageRequests({ cancel() {} });
  const choice = deferred<boolean>();
  const id = randomUUID();
  const pending = requests.run(
    1,
    id,
    'import',
    null,
    () => choice.promise,
    async () => 42,
  );
  await requests.cancel(2, id);
  await requests.cancel(1, randomUUID());
  await assert.rejects(
    requests.run(
      1,
      randomUUID(),
      'inspect',
      null,
      async () => true,
      async () => 1,
    ),
    /已有项目包/,
  );
  choice.resolve(true);
  assert.equal(await pending, 42);
  let choosing = false;
  const synchronous = requests.run(
    1,
    randomUUID(),
    'import',
    null,
    async () => {
      choosing = true;
      return true;
    },
    async () => 2,
    () => {
      void requests.cancel(1);
    },
  );
  assert.equal(await synchronous, null);
  assert.equal(choosing, false);
});

test('cancel waits for active execution cleanup; only the typed cancellation becomes null', async () => {
  for (const failure of [null, new Error('cleanup EACCES')]) {
    const requests = new PackageRequests({ cancel() {} });
    const started = deferred<void>();
    const cleanup = deferred<void>();
    const events: ProjectPackageProgress[] = [];
    const pending = requests.run(
      1,
      randomUUID(),
      'export',
      'project',
      async () => true,
      async (_choice, controls) => {
        controls.onProgress?.({ ...base, completedBytes: 64 });
        started.resolve();
        await cleanup.promise;
        if (failure) throw failure;
        controls.signal?.throwIfAborted();
        return 'unreachable';
      },
      (value) => events.push(value),
    );
    void pending.catch(() => {});
    await started.promise;
    let stopped = false;
    const cancel = requests.cancel(1).finally(() => {
      stopped = true;
    });
    void cancel.catch(() => {});
    await tick();
    assert.equal(stopped, false);
    assert.equal(events.at(-1)?.phase, 'cancelling');
    cleanup.resolve();
    if (failure) {
      await assert.rejects(pending, (error) => error === failure);
      await assert.rejects(cancel, (error) => error === failure);
      assert.equal(events.at(-1)?.phase, 'failed');
    } else {
      assert.equal(await pending, null);
      await cancel;
      assert.equal(events.at(-1)?.phase, 'cancelled');
    }
  }
  const requests = new PackageRequests({ cancel() {} });
  await assert.rejects(
    requests.run(
      1,
      randomUUID(),
      'inspect',
      null,
      async () => true,
      async () => {
        throw new Error('项目包操作已取消');
      },
    ),
    /已取消/,
    'error text alone never classifies cancellation',
  );
});

test('published success wins over late cancellation; canCancel false prevents a misleading stopping phase', async () => {
  const requests = new PackageRequests({ cancel() {} });
  const published = deferred<void>();
  const cleaned = deferred<void>();
  const events: ProjectPackageProgress[] = [];
  const pending = requests.run(
    1,
    randomUUID(),
    'export',
    'project',
    async () => true,
    async (_choice, controls) => {
      controls.onProgress?.({
        ...base,
        phase: 'finalizing',
        canCancel: false,
        completedBytes: 1000,
      });
      published.resolve();
      await cleaned.promise;
      return 'published.afflatus';
    },
    (value) => events.push(value),
  );
  await published.promise;
  const cancelling = requests.cancel(1);
  assert.equal(events.at(-1)?.phase, 'finalizing');
  cleaned.resolve();
  assert.equal(await pending, 'published.afflatus');
  await cancelling;
  assert.equal(events.at(-1)?.phase, 'completed');
});

test('owner leave leases block late IPC independently and close cannot be reopened by releasing a lease', async () => {
  let serviceCancelled = 0;
  const requests = new PackageRequests({
    cancel() {
      serviceCancelled++;
    },
  });
  const a = await requests.prepareForLeave(1);
  const b = await requests.prepareForLeave(1);
  let choices = 0;
  const start = (owner: number) =>
    requests.run(
      owner,
      randomUUID(),
      'inspect',
      null,
      async () => {
        choices++;
        return true;
      },
      async () => 42,
    );
  assert.equal(await start(1), null);
  assert.equal(choices, 0);
  assert.throws(() => requests.resumeAfterLeave(2, a), /其他窗口/);
  requests.resumeAfterLeave(1, a);
  requests.resumeAfterLeave(1, a);
  assert.equal(await start(1), null);
  requests.resumeAfterLeave(1, b);
  assert.equal(await start(1), 42);
  await requests.prepareForLeave(1);
  requests.resumeOwner(1);
  assert.equal(await start(1), 42);
  const c = await requests.prepareForLeave(1);
  await requests.close();
  requests.resumeAfterLeave(1, c);
  await assert.rejects(start(1), /关闭/);
  assert.equal(serviceCancelled, 1);
});

test('close cancels chooser promptly but waits for real execution and reports cleanup failure', async () => {
  const requests = new PackageRequests({ cancel() {} });
  const choice = deferred<boolean>();
  const pending = requests.run(
    1,
    randomUUID(),
    'import',
    null,
    () => choice.promise,
    async () => 42,
  );
  await requests.close();
  assert.equal(await pending, null);
  choice.resolve(true);
  const second = new PackageRequests({ cancel() {} });
  const entered = deferred<void>();
  const cleanup = deferred<void>();
  const actual = second.run(
    1,
    randomUUID(),
    'import',
    null,
    async () => true,
    async () => {
      entered.resolve();
      await cleanup.promise;
      throw new Error('real cleanup failure');
    },
  );
  void actual.catch(() => {});
  await entered.promise;
  const closing = second.close();
  void closing.catch(() => {});
  cleanup.resolve();
  await assert.rejects(closing, /cleanup failure/);
  await assert.rejects(actual, /cleanup failure/);
});

test('byte progress is throttled, but the first positive bytes, phase transitions and terminal state are immediate', async (t) => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const requests = new PackageRequests({ cancel() {} });
  const events: ProjectPackageProgress[] = [];
  const id = randomUUID();
  const result = await requests.run(
    1,
    id,
    'export',
    'project',
    async () => true,
    async (_choice, controls) => {
      controls.onProgress?.(base);
      for (let i = 1; i <= 10; i++)
        controls.onProgress?.({ ...base, completedBytes: i });
      now += 200;
      controls.onProgress?.({ ...base, completedBytes: 100 });
      controls.onProgress?.({
        ...base,
        phase: 'finalizing',
        completedBytes: 1000,
        canCancel: false,
      });
      return true;
    },
    (value) => events.push(value),
  );
  assert.equal(result, true);
  assert.deepEqual(
    events
      .filter((event) => event.phase === 'copying')
      .map((event) => event.completedBytes),
    [0, 1, 100],
  );
  assert.equal(events.at(-1)?.phase, 'completed');
  assert.ok(
    events.every(
      (event) =>
        event.requestId === id &&
        event.operation === 'export' &&
        event.projectId === 'project',
    ),
  );
});

test('late progress from an aborted operation stays stopping and subscriber failures do not change results', async () => {
  const requests = new PackageRequests({ cancel() {} });
  const events: ProjectPackageProgress[] = [];
  const result = requests.run(
    1,
    randomUUID(),
    'duplicate',
    'project',
    async () => true,
    async (_choice, controls) => {
      controls.onProgress?.(base);
      void requests.cancel(1);
      controls.onProgress?.({ ...base, completedBytes: 64 });
      throw new PackageCancelledError();
    },
    (value) => events.push(value),
  );
  assert.equal(await result, null);
  assert.ok(
    events
      .filter((event) => event.phase === 'cancelling')
      .every((event) => !event.canCancel),
  );
  assert.equal(
    await requests.run(
      1,
      randomUUID(),
      'inspect',
      null,
      async () => true,
      async () => 42,
      () => {
        throw new Error('detached UI');
      },
    ),
    42,
  );
});
