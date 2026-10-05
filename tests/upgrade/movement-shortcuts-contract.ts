import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { InteractionSettingsStore } from '../../src/main/settings/interaction-settings';
import type { AppStore } from '../../src/main/storage/app-store';
import type { InteractionSettings } from '../../src/shared/interaction/settings';
import { assertOriginalFiles, fileHash, type HistoricalData } from './history';

export interface MovementShortcutHistory {
  writerCommit: string;
  app: string;
  defaultRoot: string;
  expected: HistoricalData;
  oldSettings: InteractionSettings;
  rows: ReturnType<typeof movementRows>;
  files: { file: string; size: number; sha256: string }[];
}
export interface MovementShortcutReopen {
  history: MovementShortcutHistory;
  wanted: InteractionSettings;
  persisted: InteractionSettings;
  rows: ReturnType<typeof movementRows>;
}

export function movementRows(app: string) {
  const db = new DatabaseSync(join(app, 'app.sqlite'), { readOnly: true });
  try {
    const rows = (table: string) =>
      db
        .prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) => ({ ...row }));
    return {
      settings: rows('settings'),
      projects: rows('projects'),
      saves: rows('saves'),
    };
  } finally {
    db.close();
  }
}

export async function assertMovementSettings(
  contract: MovementShortcutReopen,
  store: AppStore,
) {
  const { history, wanted, persisted, rows } = contract;
  assert.deepEqual(new InteractionSettingsStore(store).get(), wanted);
  assert.deepEqual(store.get('interactions'), persisted);
  assert.deepEqual(movementRows(history.app), rows);
  assert.equal(store.root, history.expected.root);
  assert.deepEqual(store.jobs(), history.expected.jobs);
  assert.equal(store.job(history.expected.queued.id).status, 'ready');
  for (const file of history.files) {
    assert.equal((await readFile(file.file)).length, file.size, file.file);
    assert.equal(await fileHash(file.file), file.sha256, file.file);
  }
  await assertOriginalFiles(history.expected);
  await assert.rejects(access(history.defaultRoot), { code: 'ENOENT' });
}
