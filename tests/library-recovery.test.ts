import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LibrarySession } from '../src/renderer/src/features/projects/library-session';
import { ProjectRecoveryGuards } from '../src/renderer/src/features/projects/project-recovery-guards';
import { canResumeCanvas } from '../src/renderer/src/features/workspace/canvas-recovery';
import type { Asset, ProjectSnapshot } from '../src/shared/models';
import type { ProjectRecoverySnapshot } from '../src/shared/project-recovery';

const reference: Asset = {
  id: 'reference',
  name: 'first.txt',
  relativePath: 'assets/text/first.txt',
  size: 5,
  sha256: 'a'.repeat(64),
  kind: 'text',
  usage: 'reference',
};
const original: ProjectSnapshot = {
  project: { id: 'project', folder: 'project', name: 'name', updatedAt: '' },
  viewport: { x: 0, y: 0, zoom: 1 },
  assets: [],
  canvas: { version: 1, revision: 0, cards: [] },
};
const recovered = { ...original, assets: [reference] };
const guards = () => {
  const result = new ProjectRecoveryGuards();
  result.register('project', (snapshot, proof) =>
    canResumeCanvas(original, snapshot, proof) ? null : '原项目内容不同',
  );
  return result;
};

test('explicit recovery consumes one native snapshot and its proof, without a stale separate library read', async () => {
  let regularReads = 0;
  let recoveryReads = 0;
  const recoveryGuards = guards();
  const session = new LibrarySession(
    {
      getLibrary: async () => {
        throw new Error('Recovery must not read jobs in a separate IPC');
      },
      openProject: async () => {
        regularReads++;
        return original;
      },
    },
    (id, snapshot, proof) => recoveryGuards.verify(id, snapshot, proof),
    async () => {
      recoveryReads++;
      return { snapshot: recovered, savedReferenceAssets: [reference] };
    },
  );
  session.activate(original);
  await session.refreshProject();
  assert.equal(regularReads, 1);
  assert.equal(recoveryReads, 0);
  session.failProject('原磁盘离线');
  session.noteLibraryChange();
  assert.equal(await session.refreshProject(true), true);
  assert.equal(regularReads, 1);
  assert.equal(recoveryReads, 1);
  assert.deepEqual(session.getSnapshot().project, recovered);
  assert.equal(session.getSnapshot().projectUnavailable, null);
});

test('missing acknowledged references still block explicit retry and recovery read errors settle the button', async () => {
  let failRead = false;
  const recoveryGuards = guards();
  const session = new LibrarySession(
    {
      getLibrary: async () => {
        throw new Error('unused');
      },
      openProject: async () => original,
    },
    (id, snapshot, proof) => recoveryGuards.verify(id, snapshot, proof),
    async () => {
      if (failRead) throw new Error('恢复读取失败');
      return { snapshot: original, savedReferenceAssets: [reference] };
    },
  );
  session.activate(original);
  session.failProject('原磁盘离线');
  assert.equal(await session.refreshProject(true), false);
  assert.equal(session.getSnapshot().projectUnavailable?.conflict, true);
  assert.equal(session.getSnapshot().projectUnavailable?.retrying, false);
  assert.equal(session.getSnapshot().project, original);
  failRead = true;
  assert.equal(await session.refreshProject(true), false);
  assert.equal(
    session.getSnapshot().projectUnavailable?.message,
    '恢复读取失败',
  );
  assert.equal(session.getSnapshot().projectUnavailable?.retrying, false);
});

test('a recovery snapshot arriving after navigation cannot run guards or reopen a project', async () => {
  let resolve!: (value: ProjectRecoverySnapshot) => void;
  let checked = false;
  const pending = new Promise<ProjectRecoverySnapshot>((done) => {
    resolve = done;
  });
  const session = new LibrarySession(
    {
      getLibrary: async () => {
        throw new Error('unused');
      },
      openProject: async () => original,
    },
    async () => {
      checked = true;
      return null;
    },
    () => pending,
  );
  session.activate(original);
  session.failProject('原磁盘离线');
  const retry = session.refreshProject(true);
  session.home();
  resolve({ snapshot: recovered, savedReferenceAssets: [reference] });
  assert.equal(await retry, false);
  assert.equal(checked, false);
  assert.equal(session.getSnapshot().project, null);
});
