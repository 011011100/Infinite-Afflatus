import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceDraftQueue } from '../src/renderer/src/features/drafts/workspace-draft-queue';
import { emptyWorkspace, newShot } from '../src/shared/generation/workspace';
import type { WorkspaceDraftInput } from '../src/shared/workspace-draft';

const baseline = emptyWorkspace();
const workspace = (name: string) => ({
  ...baseline,
  shots: [newShot('shot', name, { x: 0, y: 0 })],
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a fixed checkpoint resolves while newer continuous edits are still waiting for slow protection', async () => {
  const pending: {
    value: WorkspaceDraftInput;
    resolve: (seq: number) => void;
  }[] = [];
  const queue = new WorkspaceDraftQueue('project', 'session', {
    protectWorkspaceDraft: (_id, value) =>
      new Promise((resolve) => pending.push({ value, resolve })),
    acknowledgeWorkspaceDraft: async () => true,
  });
  queue.prepareSubmission(baseline, workspace('A'));
  const first = queue.flush();
  queue.stage(baseline, workspace('B'));
  queue.stage(baseline, workspace('C'));
  const a = pending[0];
  assert.ok(a);
  a.resolve(a.value.seq);
  assert.equal(await first, true);
  await tick();
  assert.equal(pending.length, 2);
  const c = pending[1];
  assert.ok(c);
  assert.equal(c.value.workspace.shots[0]?.name, 'C');
  assert.equal(c.value.lastSubmitted?.shots[0]?.name, 'A');
  assert.equal(c.value.lastSubmitted?.revision, 1);
  queue.stage(baseline, workspace('D'));
  const waiting = queue.flush();
  c.resolve(c.value.seq);
  await tick();
  const d = pending[2];
  assert.ok(d);
  d.resolve(d.value.seq);
  assert.equal(await waiting, true);
});

test('protection failure retains the latest snapshot for rescue and retry; old acknowledgement carries its own sequence', async () => {
  let fail = true;
  const writes: WorkspaceDraftInput[] = [];
  const acknowledgements: number[] = [];
  const queue = new WorkspaceDraftQueue('project', 'session', {
    protectWorkspaceDraft: async (_id, value) => {
      if (fail) throw new Error('full disk');
      writes.push(structuredClone(value));
      return value.seq;
    },
    acknowledgeWorkspaceDraft: async (_id, key) => {
      acknowledgements.push(key.seq);
      return false;
    },
  });
  const a = queue.prepareSubmission(baseline, workspace('A'));
  assert.equal(await queue.flush(), false);
  await tick();
  queue.stage(baseline, workspace('B'));
  assert.equal(await queue.flush(), false);
  await tick();
  assert.equal(queue.snapshot()?.workspace.shots[0]?.name, 'B');
  assert.match(queue.getSnapshot().error ?? '', /意外退出/);
  fail = false;
  assert.equal(await queue.flush(), true);
  await queue.acknowledge(a);
  assert.deepEqual(acknowledgements, [a.seq]);
  assert.equal(writes[0]?.workspace.shots[0]?.name, 'B');
  const confirmed = { ...workspace('A'), revision: 1 };
  queue.confirm(confirmed, { ...workspace('B'), revision: 1 });
  assert.equal(await queue.flush(), true);
  assert.equal(queue.snapshot()?.lastSubmitted, undefined);
  assert.equal(queue.snapshot()?.baseline.revision, 1);
});
