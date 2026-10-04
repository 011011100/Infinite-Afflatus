import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectRenameSession } from '../src/renderer/src/features/projects/project-rename-session';
import type { DesktopBridge } from '../src/shared/desktop';
import type { ProjectSnapshot } from '../src/shared/models';
import type {
  NameEditDraftInput,
  ProjectEditDraftRecord,
} from '../src/shared/project-edit-draft';

const project = {
  id: 'project',
  folder: 'project',
  name: '原名称',
  updatedAt: '',
};
const snapshot = (name = project.name): ProjectSnapshot => ({
  project: { ...project, name },
  assets: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  canvas: { version: 1, revision: 0, cards: [] },
});
const record = (
  input: NameEditDraftInput,
): ProjectEditDraftRecord & { kind: 'name' } => ({
  ...input,
  project,
  format: 'infinite-afflatus-project-edit-draft',
  version: 1,
  updatedAt: '',
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  let stored: ProjectEditDraftRecord | null = null;
  let current = snapshot();
  const writes: NameEditDraftInput[] = [];
  const discarded: number[] = [];
  const recovered: number[] = [];
  const desktop: Pick<
    DesktopBridge,
    | 'protectProjectEditDraft'
    | 'recoverProjectEditDraft'
    | 'acknowledgeProjectEditDraft'
    | 'discardProjectEditDraft'
    | 'exportProjectEditDraft'
    | 'listProjectEditDrafts'
    | 'openProject'
  > = {
    openProject: async () => structuredClone(current),
    protectProjectEditDraft: async (_id, input) => {
      assert.equal(input.kind, 'name');
      const nameInput = input as NameEditDraftInput;
      writes.push(structuredClone(nameInput));
      stored = record(nameInput);
      return input.seq;
    },
    listProjectEditDrafts: async () => ({
      drafts: stored ? [stored] : [],
      issues: [],
    }),
    discardProjectEditDraft: async (_id, key) => {
      discarded.push(key.seq);
      if (stored?.seq !== key.seq) return false;
      stored = null;
      return true;
    },
    acknowledgeProjectEditDraft: async (_id, key) => {
      if (
        stored?.seq !== key.seq ||
        stored.kind !== 'name' ||
        stored.target.trim() !== current.project.name
      )
        return false;
      stored = null;
      return true;
    },
    recoverProjectEditDraft: async (_id, key) => {
      recovered.push(key.seq);
      assert.equal(stored?.seq, key.seq);
      assert.equal(stored?.kind, 'name');
      const input = stored as NameEditDraftInput;
      if (
        ![input.baseline, input.lastSubmitted, input.target.trim()].includes(
          current.project.name,
        )
      )
        throw new Error('名称冲突');
      current = snapshot(input.target.trim());
      stored = null;
      return current;
    },
    exportProjectEditDraft: async () => '/救援.json',
  };
  return {
    desktop,
    writes,
    discarded,
    recovered,
    get stored() {
      return stored;
    },
    set stored(value) {
      stored = value;
    },
    get current() {
      return current;
    },
    set current(value) {
      current = value;
    },
  };
}

test('continuous input protects fixed sequences serially; save waits for the exact latest checkpoint and freezes input', async () => {
  const f = fixture();
  const first = deferred<number>();
  const protect = f.desktop.protectProjectEditDraft;
  f.desktop.protectProjectEditDraft = async (id, input) => {
    await protect(id, input);
    if (input.seq === 1) return first.promise;
    return input.seq;
  };
  const s = new ProjectRenameSession(project, f.desktop, undefined, 'stream');
  s.setTarget('A');
  const checkpoint = s.flushProtection();
  s.setTarget('B');
  s.setTarget('C');
  const save = s.save(async () => {});
  s.setTarget('不能覆盖保存中的C');
  assert.equal(s.getSnapshot().target, 'C');
  assert.equal(f.recovered.length, 0);
  first.resolve(1);
  assert.equal(await checkpoint, true);
  assert.equal(await save, true);
  assert.deepEqual(
    f.writes.map((w) => [w.seq, w.target]),
    [
      [1, 'A'],
      [3, 'C'],
    ],
  );
  assert.deepEqual(f.recovered, [3]);
  assert.equal(f.current.project.name, 'C');
  assert.equal(f.stored, null);
});

test('raw empty input is protected but never submitted, and cancelling removes its exact stream', async () => {
  const f = fixture();
  const s = new ProjectRenameSession(project, f.desktop, undefined, 'stream');
  s.setTarget('  ');
  await s.flushProtection();
  assert.equal(f.stored?.kind === 'name' && f.stored.target, '  ');
  assert.equal(await s.save(async () => {}), false);
  assert.equal(f.recovered.length, 0);
  assert.equal(await s.leave(project.name), false);
  assert.equal(await s.cancel(), true);
  assert.equal(f.stored, null);
});

test('cancel waits for in-flight protection; duplicate cancel and save cannot authorize closing during another operation', async () => {
  const f = fixture();
  const pending = deferred<number>();
  const protect = f.desktop.protectProjectEditDraft;
  f.desktop.protectProjectEditDraft = async (id, input) => {
    await pending.promise;
    return protect(id, input);
  };
  const s = new ProjectRenameSession(project, f.desktop, undefined, 'stream');
  s.setTarget('改名');
  const cancel = s.cancel();
  assert.equal(await s.cancel(), false);
  assert.equal(await s.save(async () => {}), false);
  assert.deepEqual(f.discarded, []);
  pending.resolve(1);
  assert.equal(await cancel, true);
  assert.deepEqual(f.discarded, [1]);
});

test('full-disk protection failure can cancel without requiring another write, including published-but-unacknowledged file', async () => {
  for (const published of [false, true]) {
    const f = fixture();
    const protect = f.desktop.protectProjectEditDraft;
    let attempts = 0;
    f.desktop.protectProjectEditDraft = async (id, input) => {
      attempts++;
      if (published) await protect(id, input);
      throw new Error('磁盘已满');
    };
    const s = new ProjectRenameSession(project, f.desktop, undefined, 'stream');
    s.setTarget('保留');
    assert.equal(await s.flushProtection(), false);
    await tick();
    assert.match(s.getSnapshot().protectionError ?? '', /意外退出/);
    assert.equal(await s.cancel(), true);
    assert.equal(attempts, 1);
    assert.equal(f.stored, null);
  }
});

test('cancel never deletes a newer record and read failures retain an editable recovery path', async () => {
  const f = fixture();
  const s = new ProjectRenameSession(project, f.desktop, undefined, 'stream');
  s.setTarget('B');
  await s.flushProtection();
  await tick();
  f.stored = record({ ...s.input(), seq: 20, target: '较新C' });
  assert.equal(await s.cancel(), false);
  assert.deepEqual(f.discarded, []);
  assert.equal(s.isFinished(), false);
  assert.match(s.getSnapshot().error ?? '', /已变化/);
  f.desktop.listProjectEditDrafts = async () => ({
    drafts: [],
    issues: [{ file: `${project.id}.stream.json`, message: '损坏' }],
  });
  assert.equal(await s.cancel(), false);
  assert.equal(s.isFinished(), false);
  assert.equal(await s.exportDraft(), true);
});

test('lost A reply is confirmed by a real read before B receives its own durable baseline and receipt', async () => {
  const f = fixture();
  let first = true;
  f.desktop.recoverProjectEditDraft = async () => {
    if (first) {
      first = false;
      f.current = snapshot('A');
    }
    throw new Error('回执断开');
  };
  const s = new ProjectRenameSession(project, f.desktop, undefined, 'stream');
  s.setTarget('A');
  assert.equal(await s.save(async () => {}), false);
  s.setTarget('B');
  await s.flushProtection();
  assert.equal(f.writes.at(-1)?.lastSubmitted, 'A');
  assert.equal(s.canSave('A'), true);
  assert.equal(await s.save(async () => {}), false);
  s.setTarget('C');
  await s.flushProtection();
  assert.equal(f.writes.at(-1)?.baseline, 'A');
  assert.equal(f.writes.at(-1)?.lastSubmitted, 'B');
  assert.equal(f.writes.at(-1)?.target, 'C');
});

test('two actual commits with lost replies preserve C against confirmed A and receipt B, including reopening recovery', async () => {
  const f = fixture();
  const recover = f.desktop.recoverProjectEditDraft;
  const reads: string[] = [];
  f.desktop.openProject = async () => {
    reads.push(f.current.project.name);
    return structuredClone(f.current);
  };
  f.desktop.recoverProjectEditDraft = async (id, key) => {
    await recover(id, key);
    throw new Error('真实提交后的IPC回执丢失');
  };
  const s = new ProjectRenameSession(project, f.desktop, undefined, 'stream');
  s.setTarget('A');
  assert.equal(await s.save(async () => {}), false);
  assert.equal(f.current.project.name, 'A');
  s.setTarget('B');
  await s.flushProtection();
  assert.equal(f.writes.at(-1)?.lastSubmitted, 'A');
  assert.equal(await s.save(async () => {}), false);
  assert.equal(f.current.project.name, 'B');
  assert.deepEqual(reads, ['A']);
  s.setTarget('C');
  await s.flushProtection();
  assert.equal(
    s.canSave(project.name),
    true,
    'stale App snapshot must allow authoritative preflight',
  );
  assert.deepEqual(
    [
      f.writes.at(-1)?.baseline,
      f.writes.at(-1)?.target,
      f.writes.at(-1)?.lastSubmitted,
    ],
    ['A', 'C', 'B'],
  );
  const surviving = (await f.desktop.listProjectEditDrafts(project.id))
    .drafts[0];
  assert.ok(surviving?.kind === 'name');
  f.desktop.recoverProjectEditDraft = recover;
  const reopened = new ProjectRenameSession(
    f.current.project,
    f.desktop,
    surviving,
  );
  await reopened.flushProtection();
  assert.equal(reopened.getSnapshot().baseline, 'B');
  assert.equal(await reopened.save(async () => {}), true);
  assert.equal(f.current.project.name, 'C');
});

test('unavailable or conflicting preflight retains the old receipt and never submits another name', async () => {
  for (const failure of ['offline', 'conflict', 'identity', 'folder']) {
    const f = fixture();
    const recover = f.desktop.recoverProjectEditDraft;
    f.desktop.recoverProjectEditDraft = async (id, key) => {
      await recover(id, key);
      throw new Error('lost reply');
    };
    const s = new ProjectRenameSession(project, f.desktop, undefined, 'stream');
    s.setTarget('A');
    assert.equal(await s.save(async () => {}), false);
    s.setTarget('B');
    await s.flushProtection();
    const last = structuredClone(f.writes.at(-1));
    f.desktop.openProject = async () => {
      if (failure === 'offline') throw new Error('项目盘离线');
      const value = snapshot(failure === 'conflict' ? '外部修改' : 'A');
      if (failure === 'identity') value.project.id = 'other';
      if (failure === 'folder') value.project.folder = 'other';
      return value;
    };
    assert.equal(await s.save(async () => {}), false);
    assert.equal(f.recovered.length, 1);
    assert.deepEqual(f.writes.at(-1), last);
    s.setTarget('C');
    await s.flushProtection();
    assert.equal(f.writes.at(-1)?.baseline, project.name);
    assert.equal(f.writes.at(-1)?.lastSubmitted, 'A');
  }
});

test('full disk plus an unrelated damaged stream does not block cancelling an absent own name record', async () => {
  const f = fixture();
  f.desktop.protectProjectEditDraft = async () => {
    throw new Error('磁盘满');
  };
  f.desktop.listProjectEditDrafts = async () => ({
    drafts: [],
    issues: [{ file: `${project.id}.unrelated.json`, message: '旧流损坏' }],
  });
  const s = new ProjectRenameSession(project, f.desktop, undefined, 'stream');
  s.setTarget('输入');
  assert.equal(await s.flushProtection(), false);
  assert.equal(await s.cancel(), true);
  assert.deepEqual(f.discarded, []);
});

test('restoring A-committed/B-draft normalizes the baseline without decreasing its sequence or committing the name', async () => {
  const f = fixture();
  f.current = snapshot('A');
  const draft = record({
    kind: 'name',
    sessionId: 'stream',
    seq: 8,
    baseline: project.name,
    target: 'B',
    lastSubmitted: 'A',
  });
  f.stored = draft;
  const s = new ProjectRenameSession(f.current.project, f.desktop, draft);
  await s.flushProtection();
  assert.equal(f.recovered.length, 0);
  assert.deepEqual(
    f.writes.map((w) => [w.seq, w.baseline, w.target, w.lastSubmitted]),
    [[9, 'A', 'B', undefined]],
  );
  assert.equal(await s.save(async () => {}), true);
  assert.equal(f.current.project.name, 'B');
});

test('already submitted target becomes the baseline before restored input continues', async () => {
  const f = fixture();
  f.current = snapshot('A');
  const draft = record({
    kind: 'name',
    sessionId: 'stream',
    seq: 6,
    baseline: project.name,
    target: 'A',
  });
  f.stored = draft;
  const s = new ProjectRenameSession(f.current.project, f.desktop, draft);
  s.setTarget('B');
  await s.flushProtection();
  assert.equal(s.getSnapshot().key.seq, 8);
  assert.equal(f.writes.at(-1)?.baseline, 'A');
  assert.equal(await s.save(async () => {}), true);
  assert.equal(f.current.project.name, 'B');
});

test('no-op naming allows leave while changed input remains explicitly unsaved even after protection', async () => {
  const f = fixture();
  const s = new ProjectRenameSession(project, f.desktop, undefined, 'stream');
  s.setTarget(` ${project.name} `);
  assert.equal(await s.leave(project.name), true);
  assert.equal(f.stored, null);
  assert.equal(f.recovered.length, 0);
  const changed = new ProjectRenameSession(
    project,
    f.desktop,
    undefined,
    'other',
  );
  changed.setTarget('另一个名称');
  assert.equal(await changed.leave(project.name), false);
  const retained = (await f.desktop.listProjectEditDrafts(project.id))
    .drafts[0];
  assert.equal(retained?.kind === 'name' && retained.target, '另一个名称');
});

test('refresh failure after native success retries only presentation and cannot reapply a stale name', async () => {
  const f = fixture();
  const s = new ProjectRenameSession(project, f.desktop, undefined, 'stream');
  s.setTarget('新名称');
  assert.equal(
    await s.save(async () => {
      throw new Error('刷新失败');
    }),
    false,
  );
  assert.equal(s.isFinished(), true);
  assert.equal(await s.save(async () => {}), true);
  assert.equal(f.recovered.length, 1);
  assert.equal(await s.cancel(), true);
});

test('no-op leave does not freeze an editor if another save vetoes navigation; repeated leave and continued input remain valid', async () => {
  const f = fixture();
  const s = new ProjectRenameSession(project, f.desktop, undefined, 'stream');
  s.setTarget(` ${project.name} `);
  assert.equal(await s.leave(project.name), true);
  assert.equal(s.isFinished(), false);
  assert.equal(await s.leave(project.name), true);
  s.setTarget('离开取消后继续输入');
  await s.flushProtection();
  assert.equal(f.writes.at(-1)?.seq, 2);
  assert.equal(f.writes.at(-1)?.target, '离开取消后继续输入');
  assert.equal(await s.leave(project.name), false);
  assert.equal(await s.save(async () => {}), true);
});

test('restoring a name rejects another project, folder, or changed baseline before issuing any IPC', () => {
  const f = fixture();
  const draft = record({
    kind: 'name',
    sessionId: 'stream',
    seq: 2,
    baseline: project.name,
    target: 'B',
  });
  for (const current of [
    { ...project, id: 'other' },
    { ...project, folder: 'other' },
    { ...project, name: '外部修改' },
  ])
    assert.throws(() => new ProjectRenameSession(current, f.desktop, draft));
  assert.equal(f.writes.length, 0);
  assert.equal(f.recovered.length, 0);
});
