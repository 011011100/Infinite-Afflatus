import assert from 'node:assert/strict';
import test from 'node:test';
import { SaveRequest } from '../src/main/desktop/save-request';
import { LatestSaveQueue } from '../src/renderer/src/features/lifecycle/latest-save-queue';
import { PendingSaves } from '../src/renderer/src/features/lifecycle/pending-saves';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('leaving waits for imports, then saves the references they add before closing', async () => {
  const saves = new PendingSaves();
  const calls: string[] = [];
  let finish!: () => void;
  let references = 0;
  saves.register('shot', async () => {
    calls.push(`saved ${references} references`);
    return true;
  });
  saves.register(
    'import',
    async () => {
      calls.push('import');
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      references = 1;
      return true;
    },
    -10,
  );
  const leaving = saves.flush();
  assert.equal(saves.flush(), leaving);
  assert.deepEqual(calls, ['import']);
  finish();
  assert.equal(await leaving, true);
  assert.deepEqual(calls, ['import', 'saved 1 references']);
});

test('a failed draft prevents leaving, preserves other saves, and can be retried', async () => {
  const saves = new PendingSaves();
  let writable = false;
  let otherSaved = 0;
  saves.register('draft', async () => writable);
  const unregister = saves.register('viewport', async () => {
    otherSaved += 1;
    return true;
  });
  assert.equal(await saves.flush(), false);
  assert.equal(otherSaved, 1);
  writable = true;
  assert.equal(await saves.flush(), true);
  unregister();
  assert.equal(await saves.flush(), true);
  assert.equal(otherSaved, 2);
});

test('viewport saves serialize the latest position and retain it after disk failure', async () => {
  const writes: { value: number; resolve: () => void; reject: () => void }[] =
    [];
  const queue = new LatestSaveQueue<number>(
    (value) =>
      new Promise((resolve, reject) => {
        writes.push({
          value,
          resolve,
          reject: () => reject(new Error('disk offline')),
        });
      }),
  );
  void queue.update(1);
  void queue.update(2);
  void queue.update(3);
  const leave = queue.flush();
  assert.deepEqual(
    writes.map(({ value }) => value),
    [1],
  );
  writes[0]?.resolve();
  await turn();
  assert.deepEqual(
    writes.map(({ value }) => value),
    [1, 3],
  );
  writes[1]?.reject();
  assert.equal(await leave, false);
  const retry = queue.flush();
  assert.deepEqual(
    writes.map(({ value }) => value),
    [1, 3, 3],
  );
  writes[2]?.resolve();
  assert.equal(await retry, true);
  assert.equal(await queue.flush(), true);
  assert.equal(writes.length, 3);
});

test('window close accepts only its own fresh successful save acknowledgement', async () => {
  const target = {};
  const tokens: string[] = [];
  const requests = new SaveRequest<object>(
    (_, token) => tokens.push(token),
    () => assert.fail('unexpected timeout'),
  );
  const first = requests.request(target);
  assert.equal(requests.request(target), first);
  assert.throws(() => requests.acknowledge({}, tokens[0], true));
  assert.throws(() => requests.acknowledge(target, 'stale', true));
  assert.throws(() => requests.acknowledge(target, tokens[0], 'true'));
  requests.acknowledge(target, tokens[0], false);
  assert.equal(await first, false);
  const retry = requests.request(target);
  assert.notEqual(tokens[0], tokens[1]);
  assert.throws(() => requests.acknowledge(target, tokens[0], true));
  requests.acknowledge(target, tokens[1], true);
  assert.equal(await retry, true);
});

test('an unresponsive renderer keeps the window open and a late reply cannot close it', async () => {
  const target = {};
  let token = '';
  let cancelled = false;
  const requests = new SaveRequest<object>(
    (_, requestToken) => {
      token = requestToken;
    },
    () => {
      cancelled = true;
    },
    5,
  );
  assert.equal(await requests.request(target), false);
  assert.equal(cancelled, true);
  assert.throws(() => requests.acknowledge(target, token, true));
});
