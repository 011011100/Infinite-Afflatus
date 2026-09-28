import assert from 'node:assert/strict';
import test from 'node:test';
import { TrimSaveQueue } from '../src/renderer/src/features/workspace/editor/trim-save-queue';
import type { CanvasCard, CanvasPatch } from '../src/shared/canvas/model';

const card: CanvasCard = {
  id: 'group',
  assetIds: ['a', 'b'],
  position: { x: 0, y: 0 },
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const writes: { patch: CanvasPatch; finish: (saved: boolean) => void }[] = [];
  const queue = new TrimSaveQueue(
    card,
    (patch) =>
      new Promise((finish) => {
        writes.push({ patch, finish });
      }),
  );
  return { queue, writes };
}
test('rapid alternating drags retain the newest range while old saves acknowledge in order', async () => {
  const { queue, writes } = fixture();
  queue.enqueue('a', { start: 1, end: 4 });
  queue.enqueue('a', { start: 1, end: 3 });
  queue.enqueue('b', { start: 0.5, end: 2 });
  assert.equal(writes.length, 1);
  const latest = queue.getSnapshot().card;
  assert.deepEqual(latest.trims, {
    a: { start: 1, end: 3 },
    b: { start: 0.5, end: 2 },
  });
  queue.accept(card);
  assert.equal(queue.getSnapshot().card, latest);
  writes[0]?.finish(true);
  await flush();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1]?.patch.before, writes[0]?.patch.after);
  assert.equal(queue.getSnapshot().card, latest);
  assert.equal(queue.getSnapshot().pending, true);
  writes[1]?.finish(true);
  await flush();
  assert.deepEqual(writes[2]?.patch.before, writes[1]?.patch.after);
  writes[2]?.finish(true);
  await flush();
  assert.equal(queue.getSnapshot().pending, false);
  assert.equal(queue.getSnapshot().card, latest);
});
test('failed writes discard dependent changes, restore the last saved range and allow another gesture', async () => {
  const { queue, writes } = fixture();
  queue.enqueue('a', { start: 1, end: 4 });
  writes[0]?.finish(true);
  await flush();
  queue.enqueue('a', { start: 2, end: 4 });
  queue.enqueue('a', { start: 2, end: 3 });
  writes[1]?.finish(false);
  await flush();
  assert.equal(writes.length, 2);
  assert.equal(queue.getSnapshot().pending, false);
  assert.equal(queue.getSnapshot().reset, 1);
  assert.ok(queue.getSnapshot().error);
  assert.deepEqual(queue.getSnapshot().card.trims, { a: { start: 1, end: 4 } });
  queue.enqueue('a', { start: 0.5, end: 3 });
  assert.equal(queue.getSnapshot().error, null);
  assert.deepEqual(writes[2]?.patch.before, writes[0]?.patch.after);
  writes[2]?.finish(true);
  await flush();
  assert.deepEqual(queue.getSnapshot().card.trims, {
    a: { start: 0.5, end: 3 },
  });
});
test('idle external undo becomes the next trim baseline and rejected IPC unlocks the queue', async () => {
  const { queue, writes } = fixture();
  queue.enqueue('a', { start: 1, end: 4 });
  writes[0]?.finish(true);
  await flush();
  queue.accept(card);
  queue.enqueue('a', { start: 0, end: 3 });
  assert.deepEqual(writes[1]?.patch.before, [card]);
  writes[1]?.finish(true);
  await flush();
  const rejected = new TrimSaveQueue(card, async () => {
    throw new Error('IPC unavailable');
  });
  rejected.enqueue('a', { start: 1, end: 4 });
  await flush();
  assert.equal(rejected.getSnapshot().pending, false);
  assert.equal(rejected.getSnapshot().card, card);
});
