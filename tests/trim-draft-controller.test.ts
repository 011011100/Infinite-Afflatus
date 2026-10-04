import assert from 'node:assert/strict';
import test from 'node:test';
import { TrimDraftController } from '../src/renderer/src/features/workspace/editor/trim-draft-controller';
import { TrimSaveQueue } from '../src/renderer/src/features/workspace/editor/trim-save-queue';
import {
  applyCanvasPatch,
  type CanvasCard,
  type CanvasPatch,
} from '../src/shared/canvas/model';
import { reversePatch } from '../src/shared/canvas/operations';
import type { ProjectSnapshot } from '../src/shared/models';
import {
  type ProjectEditDraftRecord,
  projectEditDraftState,
  type TrimEditDraftInput,
} from '../src/shared/project-edit-draft';

const projectId = 'baf82454-cb41-4c6e-a56e-f4d153767035';
const assetId = 'f91e46db-f873-4c10-bfdb-dd087a149094';
const card: CanvasCard = {
  id: assetId,
  position: { x: 20, y: 30 },
  assetIds: [assetId],
};
const baseline: ProjectSnapshot = {
  project: {
    id: projectId,
    folder: projectId,
    name: '裁剪保护',
    updatedAt: '',
  },
  viewport: { x: 0, y: 0, zoom: 1 },
  canvas: { version: 1, revision: 4, cards: [card] },
  assets: [
    {
      id: assetId,
      name: '原片.mp4',
      relativePath: `assets/videos/${assetId}.mp4`,
      kind: 'video',
      sha256: 'a'.repeat(64),
      size: 100,
    },
  ],
};
const trimmed = (end: number) => ({
  ...card,
  trims: { [assetId]: { start: 1, end } },
});
const patch = (before: CanvasCard, after: CanvasCard) => ({
  before: [before],
  after: [after],
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  let current = structuredClone(baseline);
  let failProtect = false;
  let failAck = false;
  const records = new Map<string, TrimEditDraftInput>();
  const protectedRecords: TrimEditDraftInput[] = [];
  const events: string[] = [];
  const controller = new TrimDraftController(projectId, {
    protectProjectEditDraft: async (_id, value) => {
      assert.equal(value.kind, 'trim');
      if (failProtect) throw new Error('fixture disk full');
      const record = structuredClone(value) as TrimEditDraftInput;
      records.set(value.sessionId, record);
      protectedRecords.push(record);
      events.push(`protect:${value.seq}`);
      return value.seq;
    },
    acknowledgeProjectEditDraft: async (_id, key) => {
      if (failAck) throw new Error('fixture acknowledgement unavailable');
      const record = records.get(key.sessionId);
      if (
        !record ||
        record.seq !== key.seq ||
        projectEditDraftState(record, current) !== 'submitted'
      )
        return false;
      records.delete(key.sessionId);
      return true;
    },
  });
  return {
    controller,
    records,
    protectedRecords,
    events,
    current: () => current,
    save(value: CanvasPatch) {
      events.push('write');
      current = { ...current, canvas: applyCanvasPatch(current.canvas, value) };
    },
    failProtect: (value: boolean) => {
      failProtect = value;
    },
    failAck: (value: boolean) => {
      failAck = value;
    },
  };
}

test('a submission waits for its durable receipt; B keeps the in-flight A receipt', async () => {
  const writes: { value: TrimEditDraftInput; finish: (seq: number) => void }[] =
    [];
  const controller = new TrimDraftController(projectId, {
    protectProjectEditDraft: (_id, value) =>
      new Promise((finish) =>
        writes.push({ value: value as TrimEditDraftInput, finish }),
      ),
    acknowledgeProjectEditDraft: async () => true,
  });
  const port = controller.forCard(card, baseline.assets);
  port.stage(card, trimmed(6));
  let ready = false;
  const preparing = controller
    .prepare(baseline, patch(card, trimmed(6)), 'edit')
    .then((value) => {
      ready = true;
      return value;
    });
  port.stage(card, trimmed(4));
  await tick();
  assert.equal(writes.length, 1);
  assert.equal(ready, false);
  writes[0]?.finish(writes[0].value.seq);
  await tick();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1]?.value.lastSubmitted, trimmed(6));
  assert.equal(ready, false);
  writes[1]?.finish(writes[1].value.seq);
  await preparing;
  await tick();
  assert.deepEqual(writes[2]?.value.target, trimmed(4));
  assert.deepEqual(writes[2]?.value.lastSubmitted, trimmed(6));
  writes[2]?.finish(writes[2].value.seq);
  await tick();
});

test('lost A reply is recognized without mutation; adoption drops A and retries only B once', async () => {
  const f = fixture();
  const pending: {
    ticket: Awaited<ReturnType<TrimDraftController['prepare']>>;
    finish: (ok: boolean) => void;
  }[] = [];
  const queue = new TrimSaveQueue(
    card,
    async (value) => {
      const ticket = await f.controller.prepare(f.current(), value, 'edit');
      const ok = await new Promise<boolean>((finish) =>
        pending.push({ ticket, finish }),
      );
      if (!ok) {
        f.controller.failed(ticket);
        return false;
      }
      f.save(value);
      await f.controller.committed(ticket);
      return true;
    },
    f.controller.forCard(card, baseline.assets),
  );
  const disconnect = queue.connect();
  queue.enqueue(assetId, { start: 1, end: 6 });
  await tick();
  queue.enqueue(assetId, { start: 1, end: 4 });
  await tick();
  const a = pending[0];
  assert.ok(a);
  const failed = queue.flush();
  f.save(a.ticket.patch); // SQLite committed, but the reply is lost.
  a.finish(false);
  assert.equal(await failed, false);
  const receipt = f.controller.recoveryCandidate(f.current());
  assert.equal(receipt, a.ticket);
  assert.deepEqual(queue.getSnapshot().card, card);
  assert.equal(f.controller.hasPendingEdits(), true);
  assert.equal(f.controller.adoptRecovered(a.ticket), true);
  assert.equal(f.controller.adoptRecovered(a.ticket), false);
  assert.deepEqual(queue.getSnapshot().card, trimmed(6));
  const retry = queue.flush();
  await tick();
  assert.equal(pending.length, 2);
  const b = pending[1];
  assert.ok(b);
  assert.deepEqual(b.ticket.patch, patch(trimmed(6), trimmed(4)));
  assert.deepEqual(b.ticket.record.baseline, trimmed(6));
  assert.deepEqual(b.ticket.record.lastSubmitted, trimmed(4));
  b.finish(true);
  assert.equal(await retry, true);
  assert.equal(f.current().canvas.revision, baseline.canvas.revision + 2);
  assert.deepEqual(f.current().canvas.cards[0], trimmed(4));
  assert.deepEqual(f.controller.snapshots(), []);
  assert.equal(f.records.size, 0);
  assert.equal(f.controller.hasPendingEdits(), false);
  disconnect();
});

test('failed protection blocks submission and retains an exportable target; retry and later undo advance sequence', async () => {
  const f = fixture();
  f.failProtect(true);
  f.controller.forCard(card, baseline.assets).stage(card, trimmed(4));
  await assert.rejects(
    f.controller.prepare(baseline, patch(card, trimmed(4)), 'edit'),
  );
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.controller.snapshots()[0]?.target, trimmed(4));
  assert.match(f.controller.getSnapshot().error ?? '', /恢复副本未更新/);
  f.failProtect(false);
  assert.equal(await f.controller.retryProtection(), true);
  const ticket = await f.controller.prepare(
    baseline,
    patch(card, trimmed(4)),
    'edit',
  );
  f.save(ticket.patch);
  await f.controller.committed(ticket);
  assert.deepEqual(f.controller.snapshots(), []);
  const lastSeq = f.protectedRecords.at(-1)?.seq ?? 0;
  const undo = await f.controller.prepare(
    f.current(),
    reversePatch(ticket.patch),
    'undo',
  );
  assert.ok(undo.record.seq > lastSeq);
  assert.equal(undo.action, 'undo');
  assert.deepEqual(undo.record.target, card);
  f.save(undo.patch);
  f.controller.failed(undo);
  assert.equal(f.controller.recoveryCandidate(f.current())?.action, 'undo');
});

test('failed acknowledgement stays exportable and retry removes only a confirmed target', async () => {
  const f = fixture();
  const a = await f.controller.prepare(
    baseline,
    patch(card, trimmed(6)),
    'edit',
  );
  f.save(a.patch);
  f.failAck(true);
  await f.controller.committed(a);
  assert.equal(f.controller.snapshots().length, 1);
  assert.match(f.controller.getSnapshot().error ?? '', /裁剪已保存/);
  f.failAck(false);
  assert.equal(await f.controller.retryProtection(), true);
  assert.deepEqual(f.controller.snapshots(), []);
  assert.equal(f.records.size, 0);
});

test('an old acknowledgement completing after B was staged cannot clear B from memory or disk', async () => {
  let durable: TrimEditDraftInput | null = null;
  let releaseAck: (() => void) | undefined;
  const controller = new TrimDraftController(projectId, {
    protectProjectEditDraft: async (_id, value) => {
      durable = structuredClone(value) as TrimEditDraftInput;
      return value.seq;
    },
    acknowledgeProjectEditDraft: (_id, key) =>
      new Promise((resolve) => {
        releaseAck = () => {
          if (durable?.seq === key.seq) durable = null;
          resolve(true);
        };
      }),
  });
  const a = await controller.prepare(baseline, patch(card, trimmed(6)), 'edit');
  const settled = controller.committed(a);
  await tick();
  assert.ok(releaseAck);
  controller.forCard(card, baseline.assets).stage(trimmed(6), trimmed(4));
  releaseAck();
  await settled;
  await tick();
  assert.deepEqual(controller.snapshots()[0]?.target, trimmed(4));
  assert.deepEqual((durable as TrimEditDraftInput | null)?.target, trimmed(4));
  assert.equal(controller.hasPendingEdits(), true);
});

test('receipt refuses changed source, different canvas revision, moved card and unrelated regroup', async () => {
  const f = fixture();
  const a = await f.controller.prepare(
    baseline,
    patch(card, trimmed(6)),
    'redo',
  );
  f.save(a.patch);
  f.controller.failed(a);
  for (const mutate of [
    (s: ProjectSnapshot) => {
      const source = s.assets[0];
      assert.ok(source);
      source.sha256 = 'b'.repeat(64);
    },
    (s: ProjectSnapshot) => {
      s.canvas.revision++;
    },
    (s: ProjectSnapshot) => {
      const current = s.canvas.cards[0];
      assert.ok(current);
      current.position.x++;
    },
    (s: ProjectSnapshot) => {
      const current = s.canvas.cards[0];
      assert.ok(current);
      current.id = projectId;
    },
  ]) {
    const remote = structuredClone(f.current());
    mutate(remote);
    assert.equal(f.controller.recoveryCandidate(remote), null);
  }
  assert.equal(f.controller.hasPendingEdits(), true);
  f.controller.setGesturing(card.id, true);
  assert.equal(f.controller.getSnapshot().hasPendingEdits, true);
});

test('a reconnect can subscribe after StrictMode cleanup and an unchanged disk keeps the failed gesture retryable', async () => {
  const f = fixture();
  let fail = true;
  const queue = new TrimSaveQueue(
    card,
    async (value) => {
      const ticket = await f.controller.prepare(f.current(), value, 'edit');
      if (fail) {
        f.controller.failed(ticket);
        return false;
      }
      f.save(value);
      await f.controller.committed(ticket);
      return true;
    },
    f.controller.forCard(card, baseline.assets),
  );
  queue.connect()();
  const disconnect = queue.connect();
  queue.enqueue(assetId, { start: 1, end: 4 });
  assert.equal(await queue.flush(), false);
  f.controller.acceptUnchanged(structuredClone(baseline));
  assert.equal(f.controller.hasPendingEdits(), true);
  fail = false;
  assert.equal(await queue.flush(), true);
  assert.equal(f.current().canvas.revision, baseline.canvas.revision + 1);
  disconnect();
});

const oldRecord = (): ProjectEditDraftRecord & { kind: 'trim' } => ({
  kind: 'trim',
  sessionId: '7b396d4f-22c9-4a17-8db1-75f0e6d937db',
  seq: 7,
  baseline: structuredClone(card),
  target: trimmed(3),
  assets: structuredClone(baseline.assets),
  format: 'infinite-afflatus-project-edit-draft',
  version: 1,
  updatedAt: '',
  project: baseline.project,
});

test('explicit recovery keeps an exportable receipt and adopts its exact full canvas once without rewriting an acknowledged stream', () => {
  const f = fixture();
  const record = oldRecord();
  const ticket = f.controller.prepareRecovery(baseline, record);
  assert.equal(f.controller.hasPendingEdits(), false);
  f.save(ticket.patch);
  f.controller.failedRecovery(ticket);
  assert.equal(f.controller.hasUnconfirmedSubmission(), true);
  assert.equal(f.controller.canRetryProtection(), false);
  assert.deepEqual(f.controller.snapshots(), [record]);
  const changed = structuredClone(f.current());
  changed.canvas.revision++;
  assert.equal(f.controller.recoveryCandidate(changed), null);
  const missingSource = { ...f.current(), assets: [] };
  assert.equal(f.controller.recoveryCandidate(missingSource), null);
  assert.deepEqual(f.controller.snapshots(), [record]);
  assert.equal(f.controller.hasPendingEdits(), true);
  assert.equal(f.controller.recoveryCandidate(f.current()), ticket);
  assert.equal(f.controller.adoptRecovered(ticket), true);
  assert.equal(f.controller.adoptRecovered(ticket), false);
  assert.equal(f.controller.hasPendingEdits(), false);
  assert.equal(f.controller.canRetryProtection(), true);
  assert.equal(f.controller.getSnapshot().error, null);
  assert.deepEqual(f.controller.snapshots(), []);
  assert.deepEqual(f.protectedRecords, []);
  assert.equal(f.records.size, 0);
});

test('an explicit recovery rejected before writing releases its receipt only after the original canvas is accepted', () => {
  const f = fixture();
  const ticket = f.controller.prepareRecovery(baseline, oldRecord());
  f.controller.failedRecovery(ticket);
  const changed = structuredClone(baseline);
  changed.canvas.revision++;
  f.controller.acceptUnchanged(changed);
  assert.equal(f.controller.hasPendingEdits(), true);
  f.controller.acceptUnchanged(structuredClone(baseline));
  assert.equal(f.controller.hasPendingEdits(), false);
  assert.equal(f.controller.hasUnconfirmedSubmission(), false);
  assert.equal(f.controller.getSnapshot().error, null);
  assert.deepEqual(f.controller.snapshots(), []);
  assert.deepEqual(f.protectedRecords, []);
});
