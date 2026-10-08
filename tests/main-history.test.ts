import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MainCanvasHistory,
  type MainCanvasHistoryDirection,
  type MainCanvasOperation,
} from '../src/shared/canvas/main-history';
import {
  applyCanvasPatch,
  type CanvasDocument,
} from '../src/shared/canvas/model';
import { reversePatch } from '../src/shared/canvas/operations';
import {
  applyShotListOperation,
  type ShotListOperation,
} from '../src/shared/generation/shot-list-operations';
import {
  groupMaterials,
  newShot,
  type ShotWorkspace,
} from '../src/shared/generation/workspace';

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const video = (from: number, to: number): MainCanvasOperation => ({
  kind: 'video',
  patch: {
    before: [{ id: id(1), assetIds: [id(2)], position: { x: from, y: 0 } }],
    after: [{ id: id(1), assetIds: [id(2)], position: { x: to, y: 0 } }],
  },
});
const shotOperation = (operation: ShotListOperation): MainCanvasOperation => ({
  kind: 'shot',
  operation,
});
function reverseVideo(operation: MainCanvasOperation): MainCanvasOperation {
  assert.equal(operation.kind, 'video');
  if (operation.kind !== 'video') throw new Error('Expected video operation');
  return { kind: 'video', patch: reversePatch(operation.patch) };
}
function begin(
  history: MainCanvasHistory,
  operation: MainCanvasOperation,
  direction: MainCanvasHistoryDirection = 'edit',
) {
  const ticket = history.begin(operation, direction);
  assert.ok(ticket);
  return ticket;
}
function recordVideo(history: MainCanvasHistory, from: number, to: number) {
  const operation = video(from, to);
  assert.equal(begin(history, operation).commit(reverseVideo(operation)), true);
}
function step(history: MainCanvasHistory, direction: 'undo' | 'redo') {
  const operation = history.getSnapshot()[direction];
  assert.ok(operation);
  assert.equal(
    begin(history, operation, direction).commit(reverseVideo(operation)),
    true,
  );
  return operation;
}
function sampleShot(): ShotWorkspace {
  return groupMaterials(
    {
      ...newShot(id(3), '已编辑的镜头', { x: 20, y: 40 }),
      viewport: { x: 150, y: -90, zoom: 0.5 },
      nodes: [
        {
          id: id(4),
          type: 'text',
          text: '创建后补写的分镜',
          position: { x: 80, y: 60 },
        },
        {
          id: id(5),
          type: 'asset',
          assetId: id(6),
          name: '同源素材的独立名称',
          textOverride: '不改写源文件的文字',
          position: { x: 400, y: 60 },
        },
      ],
      labels: [
        {
          id: id(7),
          name: '恢复位置',
          color: '#336699',
          pinned: true,
          position: { x: 500, y: 800 },
        },
      ],
    },
    [id(4), id(5)],
    id(8),
  );
}

test('video, shot creation, trim, shot movement and removal undo in one saved order', () => {
  const history = new MainCanvasHistory();
  const originalCard = {
    id: id(1),
    assetIds: [id(2)],
    position: { x: 0, y: 0 },
  };
  let canvas: CanvasDocument = {
    version: 1,
    revision: 0,
    cards: [originalCard],
  };
  let shots: ShotWorkspace[] = [];
  const states = () => structuredClone({ cards: canvas.cards, shots });
  const expected = [states()];
  const apply = (
    operation: MainCanvasOperation,
    direction: MainCanvasHistoryDirection = 'edit',
  ) => {
    const ticket = begin(history, operation, direction);
    let inverse: MainCanvasOperation;
    if (operation.kind === 'video') {
      canvas = applyCanvasPatch(canvas, operation.patch);
      inverse = reverseVideo(operation);
    } else {
      const result = applyShotListOperation(shots, operation.operation);
      assert.ok(result);
      shots = result.shots;
      inverse = shotOperation(result.inverse);
    }
    assert.equal(ticket.commit(inverse), true);
  };
  const movedCard = { ...originalCard, position: { x: 80, y: 0 } };
  const trimmedCard = {
    ...movedCard,
    trims: { [id(2)]: { start: 1, end: 4 } },
  };
  const operations: MainCanvasOperation[] = [
    video(0, 80),
    shotOperation({ type: 'insert', shot: sampleShot(), index: 0 }),
    { kind: 'video', patch: { before: [movedCard], after: [trimmedCard] } },
    shotOperation({
      type: 'move',
      id: id(3),
      from: { x: 20, y: 40 },
      to: { x: 320, y: 240 },
    }),
    shotOperation({ type: 'remove', id: id(3) }),
  ];
  for (const operation of operations) {
    apply(operation);
    expected.push(states());
  }
  for (let index = expected.length - 2; index >= 0; index--) {
    const operation = history.getSnapshot().undo;
    assert.ok(operation);
    apply(operation, 'undo');
    assert.deepEqual(states(), expected[index]);
  }
  assert.equal(history.getSnapshot().undo, null);
  for (let index = 1; index < expected.length; index++) {
    const operation = history.getSnapshot().redo;
    assert.ok(operation);
    apply(operation, 'redo');
    assert.deepEqual(states(), expected[index]);
  }
  assert.equal(history.getSnapshot().redo, null);
  assert.equal(
    canvas.revision,
    6,
    'each actual video write keeps increasing revision',
  );
});

test('undoing creation and redoing removal capture the latest complete shot, not its original shell', () => {
  const history = new MainCanvasHistory();
  let shots: ShotWorkspace[] = [];
  const apply = (
    operation: MainCanvasOperation,
    direction: MainCanvasHistoryDirection,
  ) => {
    assert.equal(operation.kind, 'shot');
    if (operation.kind !== 'shot') throw new Error('Expected shot operation');
    const ticket = begin(history, operation, direction);
    const result = applyShotListOperation(shots, operation.operation);
    assert.ok(result);
    shots = result.shots;
    assert.equal(ticket.commit(shotOperation(result.inverse)), true);
  };
  const empty = newShot(id(3), '空镜头', { x: 20, y: 40 });
  apply(shotOperation({ type: 'insert', shot: empty, index: 0 }), 'edit');
  // Content editing belongs to ShotHistory and does not append to this timeline.
  shots = [sampleShot()];
  const latest = structuredClone(shots);
  const undo = history.getSnapshot().undo;
  assert.ok(undo);
  apply(undo, 'undo');
  assert.deepEqual(shots, []);
  const redo = history.getSnapshot().redo;
  assert.ok(redo);
  apply(redo, 'redo');
  assert.deepEqual(shots, latest);

  apply(shotOperation({ type: 'remove', id: id(3) }), 'edit');
  const restore = history.getSnapshot().undo;
  assert.ok(restore);
  apply(restore, 'undo');
  // apply() replaces the runtime array after the earlier empty-array assertion.
  const current = (shots as ShotWorkspace[])[0];
  assert.ok(current);
  shots = [
    { ...current, name: '恢复后又改名', viewport: { x: 3, y: 4, zoom: 1 } },
  ];
  const revised = structuredClone(shots);
  const removeAgain = history.getSnapshot().redo;
  assert.ok(removeAgain);
  apply(removeAgain, 'redo');
  const restoreAgain = history.getSnapshot().undo;
  assert.ok(restoreAgain);
  apply(restoreAgain, 'undo');
  assert.deepEqual(shots, revised);
});

test('failed saves keep both branches; only a committed new edit clears redo', () => {
  const history = new MainCanvasHistory();
  recordVideo(history, 0, 10);
  recordVideo(history, 10, 20);
  step(history, 'undo');
  const before = history.getSnapshot();
  const failed = begin(history, video(10, 30));
  assert.equal(history.getSnapshot().busy, true);
  assert.equal(history.getSnapshot().undo, before.undo);
  assert.equal(history.getSnapshot().redo, before.redo);
  assert.equal(history.begin(video(10, 40)), null);
  assert.equal(failed.abort(), true);
  assert.deepEqual(history.getSnapshot(), before);
  assert.equal(failed.commit(video(30, 10)), false);
  const successful = begin(history, video(10, 30));
  assert.equal(history.getSnapshot().redo, before.redo);
  assert.equal(successful.commit(video(30, 10)), true);
  assert.equal(history.getSnapshot().redo, null);
  assert.deepEqual(history.getSnapshot().undo, video(30, 10));
});

test('undo and redo reject a different stack head while accepting equivalent property order', () => {
  const history = new MainCanvasHistory();
  assert.equal(history.begin(video(10, 0), 'undo'), null);
  recordVideo(history, 0, 10);
  assert.equal(history.begin(video(99, 0), 'undo'), null);
  assert.equal(history.begin(video(0, 10), 'redo'), null);
  const reordered: MainCanvasOperation = {
    patch: {
      after: [{ position: { y: 0, x: 0 }, assetIds: [id(2)], id: id(1) }],
      before: [{ position: { y: 0, x: 10 }, assetIds: [id(2)], id: id(1) }],
    },
    kind: 'video',
  };
  const undo = begin(history, reordered, 'undo');
  assert.equal(undo.commit(video(0, 10)), true);
  assert.equal(history.begin(video(0, 11), 'redo'), null);
  const redo = begin(history, video(0, 10), 'redo');
  assert.equal(redo.abort(), true);
  assert.deepEqual(history.getSnapshot().redo, video(0, 10));
});

test('old and double-settled tickets cannot release or alter a newer operation', () => {
  const history = new MainCanvasHistory();
  const old = begin(history, video(0, 10));
  assert.equal(old.abort(), true);
  const next = begin(history, video(0, 20));
  assert.equal(old.abort(), false);
  assert.equal(old.commit(video(10, 0)), false);
  assert.equal(history.getSnapshot().busy, true);
  assert.equal(next.commit(video(20, 0)), true);
  const committed = history.getSnapshot();
  assert.equal(next.commit(video(20, 0)), false);
  assert.equal(next.abort(), false);
  assert.equal(history.getSnapshot(), committed);
});

test('caller-owned input and returned snapshots cannot mutate later undo payloads', () => {
  const history = new MainCanvasHistory();
  const requested = shotOperation({ type: 'remove', id: id(3) });
  const inverse = shotOperation({
    type: 'insert',
    shot: sampleShot(),
    index: 0,
  });
  const expected = structuredClone(inverse);
  const ticket = begin(history, requested);
  requested.kind = 'video';
  assert.equal(ticket.commit(inverse), true);
  assert.equal(inverse.kind, 'shot');
  if (inverse.kind !== 'shot' || inverse.operation.type !== 'insert')
    throw new Error('Expected insert');
  inverse.operation.shot.name = '外部更改';
  inverse.operation.shot.nodes.length = 0;
  const snapshot = history.getSnapshot();
  assert.deepEqual(snapshot.undo, expected);
  const exposed = snapshot.undo;
  assert.ok(exposed?.kind === 'shot' && exposed.operation.type === 'insert');
  const exposedShot = exposed.operation.shot;
  assert.throws(() => {
    exposedShot.name = '不能从UI污染历史';
  }, TypeError);
  assert.deepEqual(history.getSnapshot().undo, expected);
});

test('external-store snapshots stay stable between changes and subscribers can unsubscribe', () => {
  const history = new MainCanvasHistory();
  const snapshots = [history.getSnapshot()];
  const unsubscribe = history.subscribe(() =>
    snapshots.push(history.getSnapshot()),
  );
  assert.equal(history.getSnapshot(), snapshots[0]);
  history.discardKind('shot');
  assert.equal(snapshots.length, 1);
  const ticket = begin(history, video(0, 10));
  assert.equal(snapshots.length, 2);
  assert.equal(history.begin(video(0, 20)), null);
  assert.equal(snapshots.length, 2);
  ticket.commit(video(10, 0));
  assert.equal(snapshots.length, 3);
  assert.equal(history.getSnapshot(), snapshots[2]);
  unsubscribe();
  recordVideo(history, 10, 20);
  assert.equal(snapshots.length, 3);
});

test('discarding recovered shot history keeps video order on both branches', () => {
  const history = new MainCanvasHistory();
  const created = shotOperation({
    type: 'insert',
    shot: sampleShot(),
    index: 0,
  });
  const removed = shotOperation({ type: 'remove', id: id(3) });
  recordVideo(history, 0, 10);
  begin(history, created).commit(removed);
  recordVideo(history, 10, 20);
  begin(history, removed).commit(created);
  recordVideo(history, 20, 30);
  step(history, 'undo');
  begin(history, created, 'undo').commit(removed);
  history.discardKind('shot');
  assert.deepEqual(history.getSnapshot().undo, video(20, 10));
  assert.deepEqual(history.getSnapshot().redo, video(20, 30));
  assert.deepEqual(step(history, 'undo'), video(20, 10));
  assert.deepEqual(step(history, 'undo'), video(10, 0));
  assert.equal(history.getSnapshot().undo, null);
  assert.deepEqual(step(history, 'redo'), video(0, 10));
  assert.deepEqual(step(history, 'redo'), video(10, 20));
  assert.deepEqual(step(history, 'redo'), video(20, 30));
  assert.equal(history.getSnapshot().redo, null);
});

test('discard invalidates only an affected in-flight ticket, including a late acknowledgement', () => {
  const history = new MainCanvasHistory();
  const removed = shotOperation({ type: 'remove', id: id(3) });
  const inserted = shotOperation({
    type: 'insert',
    shot: sampleShot(),
    index: 0,
  });
  begin(history, inserted).commit(removed);
  const old = begin(history, removed, 'undo');
  history.discardKind('shot');
  const current = begin(history, video(0, 10));
  assert.equal(old.commit(inserted), false);
  assert.equal(old.abort(), false);
  assert.equal(history.getSnapshot().busy, true);
  history.discardKind('shot');
  assert.equal(current.commit(video(10, 0)), true);
  assert.deepEqual(history.getSnapshot().undo, video(10, 0));
});

test('step and byte limits also cover dynamically captured redo payloads', () => {
  const steps = new MainCanvasHistory(2);
  recordVideo(steps, 0, 10);
  recordVideo(steps, 10, 20);
  recordVideo(steps, 20, 30);
  assert.deepEqual(step(steps, 'undo'), video(30, 20));
  assert.deepEqual(step(steps, 'undo'), video(20, 10));
  assert.equal(steps.getSnapshot().undo, null);
  assert.deepEqual(step(steps, 'redo'), video(10, 20));
  assert.deepEqual(step(steps, 'redo'), video(20, 30));

  const removed = shotOperation({ type: 'remove', id: id(3) });
  const inserted = shotOperation({
    type: 'insert',
    shot: sampleShot(),
    index: 0,
  });
  const bytes = (operation: MainCanvasOperation) =>
    JSON.stringify(operation).length * 2;
  const bounded = new MainCanvasHistory(
    50,
    bytes(inserted) + bytes(video(10, 0)) - 1,
  );
  recordVideo(bounded, 0, 10);
  begin(bounded, inserted).commit(removed);
  begin(bounded, removed, 'undo').commit(inserted);
  assert.equal(
    bounded.getSnapshot().undo,
    null,
    'oldest payload is evicted across both stacks',
  );
  assert.deepEqual(bounded.getSnapshot().redo, inserted);
  const tiny = new MainCanvasHistory(50, 1);
  recordVideo(tiny, 0, 10);
  assert.deepEqual(tiny.getSnapshot(), { undo: null, redo: null, busy: false });
});

test('invalid inverse kinds and capacity arguments fail without silently rewriting history', () => {
  const history = new MainCanvasHistory();
  const ticket = begin(history, video(0, 10));
  assert.throws(
    () => ticket.commit(shotOperation({ type: 'remove', id: id(3) })),
    /类型不一致/,
  );
  assert.deepEqual(history.getSnapshot(), {
    undo: null,
    redo: null,
    busy: true,
  });
  assert.equal(ticket.abort(), true);
  assert.throws(() => new MainCanvasHistory(-1), /容量无效/);
  assert.throws(() => new MainCanvasHistory(1, Number.NaN), /容量无效/);
});
