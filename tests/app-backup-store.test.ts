import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type TestContext, test } from 'node:test';
import { AppStore } from '../src/main/storage/app-store';

async function fixture(t: TestContext) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-sqlite-checkpoint-')),
  );
  const root = join(base, 'projects');
  await mkdir(root);
  const file = join(base, 'app.sqlite');
  const store = new AppStore(file, root);
  t.after(async () => {
    await store.close();
    await rm(base, { recursive: true, force: true });
  });
  return { base, root, file, store };
}

test('AppStore snapshots a committed WAL transaction without checkpointing into a raw-copy illusion', async (t) => {
  const f = await fixture(t);
  const connection = new DatabaseSync(f.file);
  try {
    connection.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    f.store.set('walOnly', { text: '已提交但还在 WAL 中' });
    assert.ok((await stat(`${f.file}-wal`)).size > 0);
    const snapshot = join(f.base, 'snapshot.sqlite');
    await f.store.snapshot(snapshot);
    const result = new DatabaseSync(snapshot, { readOnly: true });
    try {
      assert.equal(
        result.prepare('PRAGMA quick_check').get()?.quick_check,
        'ok',
      );
      assert.deepEqual(
        JSON.parse(
          String(
            result
              .prepare('SELECT value FROM settings WHERE key=?')
              .get('walOnly')?.value,
          ),
        ),
        { text: '已提交但还在 WAL 中' },
      );
    } finally {
      result.close();
    }
    assert.ok(
      (await stat(`${f.file}-wal`)).size > 0,
      'The fixture still has a live WAL, rather than testing a pre-checkpointed database',
    );
  } finally {
    connection.close();
  }
});

test('AppStore.close waits for its pending snapshot and forbids starting another snapshot', async (t) => {
  const f = await fixture(t);
  f.store.set('beforeClose', { preserved: true });
  const file = join(f.base, 'during-close.sqlite');
  const copying = f.store.snapshot(file);
  const closing = f.store.close();
  await copying;
  await closing;
  const result = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(
      result
        .prepare('SELECT value FROM settings WHERE key=?')
        .get('beforeClose')?.value,
      '{"preserved":true}',
    );
  } finally {
    result.close();
  }
  await assert.rejects(
    f.store.snapshot(join(f.base, 'after-close.sqlite')),
    /关闭/,
  );
});

test('AppStore.snapshot rejects an existing destination without changing its bytes', async (t) => {
  const f = await fixture(t);
  const file = join(f.base, 'existing.sqlite');
  await writeFile(file, 'user file must not be overwritten');
  await assert.rejects(f.store.snapshot(file), /已存在/);
  assert.equal(
    await readFile(file, 'utf8'),
    'user file must not be overwritten',
  );
});
