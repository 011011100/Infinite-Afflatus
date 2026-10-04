import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { backup, type DatabaseSync } from 'node:sqlite';
import type { ProjectSummary } from '../../shared/models';
import {
  type BackupAnchor,
  GENERATION_KEY,
  generationToken,
} from '../backups/backup-anchor';
import type { MigrationJournal } from '../migration/manifest';
import { verifyAppStore } from '../storage/app-store-guard';
import { openDatabase, transaction } from '../storage/database';
import {
  assertFileEvidence,
  requireDatabase,
  requireIndependentDatabase,
  same,
} from './relocation-files';
import type { DatabaseEvidence } from './root-relocation-types';

type Row = Record<string, string>;
export interface ApplicationRows {
  settings: Row[];
  projects: Row[];
  saves: Row[];
}
function rows(db: DatabaseSync): ApplicationRows {
  return Object.fromEntries(
    ['settings', 'projects', 'saves'].map((table) => [
      table,
      db
        .prepare(
          `SELECT CAST(rowid AS TEXT) AS _rowid, * FROM ${table} ORDER BY rowid`,
        )
        .all(),
    ]),
  ) as unknown as ApplicationRows;
}
export function setting(data: ApplicationRows, key: string): unknown {
  const value = data.settings.find((row) => row.key === key)?.value;
  return value === undefined
    ? null
    : key === 'root'
      ? value
      : JSON.parse(value);
}
export async function readApplication(path: string, signal?: AbortSignal) {
  const evidence = await requireDatabase(path, signal);
  await requireIndependentDatabase(path);
  assertFileEvidence(path, evidence);
  const db = openDatabase(path, true);
  let data: ApplicationRows;
  try {
    assertFileEvidence(path, evidence);
    verifyAppStore(db);
    data = rows(db);
  } finally {
    db.close();
  }
  if (!same(await requireDatabase(path, signal), evidence))
    throw new Error('应用数据库在检查期间变化');
  return { evidence, data };
}
export function projectsIn(data: ApplicationRows) {
  return data.projects.map(
    (row) => JSON.parse(row.payload ?? '') as ProjectSummary,
  );
}
export function requireStableApplication(
  data: ApplicationRows,
  anchor: BackupAnchor,
) {
  if (
    anchor.initializing ||
    anchor.migration ||
    setting(data, 'root') !== anchor.root.path ||
    !same(setting(data, GENERATION_KEY), generationToken(anchor))
  )
    throw new Error('应用数据库与独立目录代际不符，未重新定位');
  const migration = setting(data, 'migration') as MigrationJournal | null;
  if (
    migration &&
    !['completed', 'failed', 'cancelled'].includes(migration.status?.phase)
  )
    throw new Error('目录迁移尚未结束，请先恢复原位置');
  for (const key of ['project-package-work', 'asset-repair-work']) {
    const value = setting(data, key);
    if (value !== null && (!Array.isArray(value) || value.length))
      throw new Error('原目录仍有未完成的文件操作，请先恢复原位置');
  }
}
function projected(
  data: ApplicationRows,
  target: BackupAnchor,
): ApplicationRows {
  return {
    ...data,
    settings: data.settings.map((row) =>
      row.key === 'root'
        ? { ...row, value: target.root.path }
        : row.key === GENERATION_KEY
          ? { ...row, value: JSON.stringify(generationToken(target)) }
          : row,
    ),
  };
}
export async function makeCandidate(
  source: string,
  target: string,
  evidence: DatabaseEvidence,
  anchor: BackupAnchor,
) {
  const original = await readApplication(source);
  if (!same(original.evidence, evidence))
    throw new Error('应用数据库在确认后变化');
  const input = openDatabase(source, true);
  try {
    assertFileEvidence(source, evidence);
    await backup(input, target);
  } finally {
    input.close();
  }
  if (!same(await requireDatabase(source), evidence))
    throw new Error('应用数据库在复制期间变化');
  const db = openDatabase(target);
  try {
    if (!same(rows(db), original.data))
      throw new Error('候选数据库未完整保留原记录');
    transaction(db, () => {
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
        anchor.root.path,
        'root',
      );
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
        JSON.stringify(generationToken(anchor)),
        GENERATION_KEY,
      );
      verifyAppStore(db);
      if (!same(rows(db), projected(original.data, anchor)))
        throw new Error('重定位改变了保存位置以外的记录');
    });
  } finally {
    db.close();
  }
  const handle = await open(target, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  return requireDatabase(target);
}
export function requireProjection(
  original: ApplicationRows,
  candidate: ApplicationRows,
  anchor: BackupAnchor,
) {
  if (!same(projected(original, anchor), candidate))
    throw new Error('候选数据库记录与原库不符，已保留全部资料');
}
