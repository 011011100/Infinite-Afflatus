import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { StartupLifetime } from '../src/main/startup/startup-lifetime';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function host() {
  const events = new EventEmitter();
  const stopped = deferred<void>();
  let quits = 0;
  let prevented = 0;
  let exit: number | undefined;
  const app = Object.assign(events, {
    quit() {
      let prevent = false;
      events.emit('before-quit', {
        preventDefault() {
          prevent = true;
          prevented++;
        },
      });
      if (!prevent) {
        quits++;
        stopped.resolve();
      }
    },
    exit(code: number) {
      exit = code;
      stopped.resolve();
    },
  });
  return {
    app,
    stopped,
    get quits() {
      return quits;
    },
    get prevented() {
      return prevented;
    },
    get exit() {
      return exit;
    },
  };
}

test('startup quit is single-flight, aborts late work and waits for an acquired library to close', async () => {
  const h = host();
  const open = deferred<void>();
  let closed = false;
  let recoveryClosed = 0;
  const lifetime = new StartupLifetime(
    h.app as unknown as ConstructorParameters<typeof StartupLifetime>[0],
    async () => {
      recoveryClosed++;
    },
  );
  const acquiring = lifetime.track(async () => {
    await open.promise;
    if (lifetime.signal.aborted) {
      closed = true;
      throw lifetime.signal.reason;
    }
    return 'library';
  });
  const rejected = assert.rejects(acquiring, /正在退出/);
  h.app.quit();
  h.app.quit();
  assert.equal(h.quits, 0);
  assert.equal(recoveryClosed, 1);
  assert.throws(() => lifetime.track(async () => 'late'), /正在退出/);
  open.resolve();
  await rejected;
  await h.stopped.promise;
  assert.equal(closed, true);
  assert.equal(h.quits, 1);
  assert.equal(h.app.listenerCount('before-quit'), 0);
});

test('startup exit waits for already confirmed storage, while an unresolved native picker is not a storage lock', async () => {
  const h = host();
  const committed = deferred<void>();
  const lifetime = new StartupLifetime(
    h.app as unknown as ConstructorParameters<typeof StartupLifetime>[0],
    () => committed.promise,
  );
  const disk = deferred<void>();
  const restoring = lifetime.track(() => disk.promise);
  h.app.quit();
  committed.resolve();
  await Promise.resolve();
  assert.equal(h.quits, 0);
  disk.resolve();
  await restoring;
  await h.stopped.promise;
  assert.equal(h.quits, 1);
});

test('detaching successful startup leaves the normal application close handler in control', () => {
  const h = host();
  let normal = 0;
  h.app.on('before-quit', () => {
    normal++;
  });
  const lifetime = new StartupLifetime(
    h.app as unknown as ConstructorParameters<typeof StartupLifetime>[0],
    async () => assert.fail('startup no longer owns shutdown'),
  );
  lifetime.detach();
  h.app.quit();
  assert.equal(normal, 1);
  assert.equal(h.prevented, 0);
  assert.equal(lifetime.signal.aborted, false);
});
