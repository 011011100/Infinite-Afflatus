import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LatestSaveQueue } from '../src/renderer/src/features/lifecycle/latest-save-queue';
import { LibrarySession } from '../src/renderer/src/features/projects/library-session';
import { ProjectRecoveryGuards } from '../src/renderer/src/features/projects/project-recovery-guards';
import { defaultInteractionSettings } from '../src/shared/interaction/settings';
import type { LibraryState, ProjectSnapshot } from '../src/shared/models';

const project = (id = 'project', revision = 0): ProjectSnapshot => ({
  project: { id, name: id, folder: id, updatedAt: '' },
  viewport: { x: 0, y: 0, zoom: 1 },
  assets: [],
  canvas: { version: 1, revision, cards: [] },
});
const library = (): LibraryState => ({
  root: '/projects',
  projects: [],
  jobs: [],
  migration: null,
  writeBlocked: false,
  interactions: defaultInteractionSettings(),
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test('global library state continues refreshing while a failed project retains the last verified view until explicit retry', async () => {
  let available = true;
  let reads = 0;
  let state = library();
  const original = project();
  const session = new LibrarySession({
    getLibrary: async () => state,
    openProject: async () => {
      reads++;
      if (!available) throw new Error('磁盘离线');
      return structuredClone(original);
    },
  });
  await session.open('project');
  available = false;
  state = { ...state, writeBlocked: true };
  await session.refresh();
  assert.equal(session.getSnapshot().library?.writeBlocked, true);
  assert.deepEqual(session.getSnapshot().project, original);
  const unavailable = session.getSnapshot().projectUnavailable;
  assert.equal(unavailable?.message, '磁盘离线');
  assert.ok(unavailable?.lastVerifiedAt);
  available = true;
  state = { ...state, writeBlocked: false, root: '/new-root' };
  const before = reads;
  await session.refresh();
  assert.equal(session.getSnapshot().library?.root, '/new-root');
  assert.equal(reads, before);
  assert.ok(session.getSnapshot().projectUnavailable);
  assert.equal(await session.refreshProject(true), true);
  assert.equal(session.getSnapshot().projectUnavailable, null);
});

test('late reads cannot clear a newer failure or reopen a project after navigation', async () => {
  const requests: ReturnType<typeof deferred<ProjectSnapshot>>[] = [];
  const session = new LibrarySession({
    getLibrary: async () => library(),
    openProject: () => {
      const request = deferred<ProjectSnapshot>();
      requests.push(request);
      return request.promise;
    },
  });
  session.activate(project());
  const pending = session.refreshProject();
  session.failProject(new Error('写入失败'));
  requests[0]?.resolve(project());
  await pending;
  assert.equal(session.getSnapshot().projectUnavailable?.message, '写入失败');
  const retry = session.refreshProject(true);
  session.home();
  requests[1]?.resolve(project());
  await retry;
  assert.equal(session.getSnapshot().project, null);
  assert.equal(session.getSnapshot().projectUnavailable, null);
  const first = session.open('first');
  const second = session.open('second');
  requests[3]?.resolve(project('second'));
  await second;
  requests[2]?.resolve(project('first'));
  await first;
  assert.equal(session.getSnapshot().project?.project.id, 'second');
});

test('stale global reads do not replace newer library state; project rejection is handled independently', async () => {
  const first = deferred<LibraryState>();
  let calls = 0;
  const session = new LibrarySession({
    getLibrary: async () =>
      ++calls === 1 ? first.promise : { ...library(), root: '/new' },
    openProject: async () => {
      throw new Error('bad DB');
    },
  });
  session.activate(project());
  const pending = session.refresh();
  await session.refresh();
  first.resolve({ ...library(), root: '/old' });
  await pending;
  assert.equal(session.getSnapshot().library?.root, '/new');
  assert.equal(session.getSnapshot().projectUnavailable?.message, 'bad DB');
});

test('recovery guards preserve an unavailable project on conflict or invalid workspace and run only on explicit retry', async () => {
  let reason: string | null = '草稿版本已变化';
  let checks = 0;
  const guards = new ProjectRecoveryGuards();
  guards.register('project', () => {
    checks++;
    return reason;
  });
  const session = new LibrarySession(
    {
      getLibrary: async () => library(),
      openProject: async () => project('project', 7),
    },
    (id, snapshot) => guards.verify(id, snapshot),
  );
  session.activate(project());
  session.failProject('原数据库离线');
  await session.refresh();
  assert.equal(checks, 0);
  assert.equal(await session.refreshProject(true), false);
  assert.equal(session.getSnapshot().project?.canvas.revision, 0);
  assert.equal(session.getSnapshot().projectUnavailable?.conflict, true);
  reason = null;
  const unregister = guards.register('project', () => {
    throw new Error('草稿损坏');
  });
  assert.equal(await session.refreshProject(true), false);
  assert.equal(session.getSnapshot().projectUnavailable?.message, '草稿损坏');
  unregister();
  assert.equal(await session.refreshProject(true), true);
  assert.equal(session.getSnapshot().project?.canvas.revision, 7);
});

test('pausing viewport writes retains the latest queued value after a late acknowledgement, while clean flush still allows navigation', async () => {
  let writable = true;
  const pending = deferred<void>();
  const values: number[] = [];
  const queue = new LatestSaveQueue<number>(
    async (value) => {
      values.push(value);
      if (value === 1) await pending.promise;
    },
    () => writable,
  );
  const first = queue.update(1);
  void queue.update(2);
  void queue.update(3);
  writable = false;
  pending.resolve();
  assert.equal(await first, false);
  assert.deepEqual(values, [1]);
  assert.equal(await queue.flush(), false);
  writable = true;
  assert.equal(await queue.flush(), true);
  assert.deepEqual(values, [1, 3]);
  writable = false;
  assert.equal(await queue.flush(), true);
});

test('focus verification catches external same-ID changes without adopting them, while expected library changes remain refreshable', async () => {
  let remote = project('project', 2);
  const original = project('project', 1);
  let guardCalls = 0;
  const session = new LibrarySession(
    { getLibrary: async () => library(), openProject: async () => remote },
    async () => {
      guardCalls++;
      return '原基线不同';
    },
  );
  session.activate(original);
  await session.refresh(true);
  assert.equal(session.getSnapshot().project?.canvas.revision, 1);
  assert.equal(session.getSnapshot().projectUnavailable?.conflict, true);
  assert.equal(guardCalls, 2);
  session.activate(original);
  await session.refresh();
  assert.equal(session.getSnapshot().project?.canvas.revision, 2);
  remote = project('project', 1);
  await session.refresh();
  assert.equal(session.getSnapshot().project?.canvas.revision, 2);
  assert.ok(session.getSnapshot().projectUnavailable);
});

test('focus retries a snapshot captured before the pending write acknowledgement once instead of freezing valid edits', async () => {
  let calls = 0;
  const session = new LibrarySession(
    {
      getLibrary: async () => library(),
      openProject: async () => project('project', ++calls),
    },
    async (_id, snapshot) =>
      snapshot.canvas.revision === 2 ? null : '先前读到旧快照',
  );
  session.activate(project());
  await session.refresh(true);
  assert.equal(session.getSnapshot().projectUnavailable, null);
  assert.equal(session.getSnapshot().project?.canvas.revision, 2);
  assert.equal(calls, 2);
});

test('a background save notification pending debounce takes priority over focus even after the importing run ended', async () => {
  const original = project();
  const imported = {
    ...original,
    assets: [
      {
        id: 'new-asset',
        name: 'new',
        relativePath: 'assets/videos/new.mp4',
        kind: 'video' as const,
        size: 1,
        sha256: 'a'.repeat(64),
      },
    ],
  };
  let confirmed = original;
  let verifications = 0;
  const session = new LibrarySession(
    { getLibrary: async () => library(), openProject: async () => imported },
    async (_id, snapshot) => {
      verifications++;
      return JSON.stringify(snapshot.assets) ===
        JSON.stringify(confirmed.assets)
        ? null
        : '素材不同';
    },
  );
  session.activate(original);
  // The import IPC has returned, but the save worker's library event is still debounced.
  session.noteLibraryChange();
  await session.refresh(true);
  assert.equal(session.getSnapshot().projectUnavailable, null);
  assert.deepEqual(session.getSnapshot().project?.assets, imported.assets);
  assert.equal(verifications, 0);
  confirmed = imported;
  await session.refresh(true);
  assert.equal(verifications, 1);
  assert.equal(session.getSnapshot().projectUnavailable, null);
});

test('an internal save notification invalidates an already-running strict focus check before it can freeze the project', async () => {
  const original = project();
  const pending = deferred<ProjectSnapshot>();
  let first = true;
  const changed = project('project', 1);
  const session = new LibrarySession(
    {
      getLibrary: async () => library(),
      openProject: async () => {
        if (first) {
          first = false;
          return pending.promise;
        }
        return changed;
      },
    },
    async () => '不同基线',
  );
  session.activate(original);
  const focus = session.refreshProject(false, true);
  session.noteLibraryChange();
  pending.resolve(changed);
  await focus;
  assert.equal(session.getSnapshot().projectUnavailable, null);
  await session.refresh();
  assert.equal(session.getSnapshot().project?.canvas.revision, 1);
  assert.equal(session.getSnapshot().projectUnavailable, null);
});

test('a save notification received during the global library read prevents a stale strict focus comparison', async () => {
  const pending = deferred<LibraryState>();
  const original = project();
  const imported: ProjectSnapshot = {
    ...original,
    assets: [
      {
        id: 'saved-in-background',
        name: 'saved',
        relativePath: 'assets/videos/saved.mp4',
        kind: 'video',
        size: 1,
        sha256: 'b'.repeat(64),
      },
    ],
  };
  let verifications = 0;
  const session = new LibrarySession(
    {
      getLibrary: () => pending.promise,
      openProject: async () => imported,
    },
    async () => {
      verifications++;
      return '素材不同';
    },
  );
  session.activate(original);
  const focus = session.refresh(true);
  session.noteLibraryChange();
  pending.resolve(library());
  await focus;
  assert.equal(verifications, 0);
  assert.equal(session.getSnapshot().projectUnavailable, null);
  assert.deepEqual(session.getSnapshot().project?.assets, imported.assets);
});
