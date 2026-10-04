import { readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  AppBackupInfo,
  AppBackupList,
  AppBackupRecoveryReport,
} from '../../shared/app-backup';
import type { ProjectSummary, SaveJob } from '../../shared/models';
import { verifyAppStore } from '../storage/app-store-guard';
import { errorMessage, openDatabase } from '../storage/database';
import { fingerprint, safeFile } from '../storage/files';
import {
  type BackupAnchor,
  decodeAnchor,
  sameAnchor,
  stableAnchor,
} from './backup-anchor';
import {
  BACKUP_DIRECTORY,
  type DirectoryIdentity,
  directoryIdentity,
  info,
  MAX_DATABASE_BYTES,
  RETAINED_DIRECTORY,
  readJson,
  UUID,
  verifyDirectory,
} from './backup-files';

export const RECOVERY_REPORT_KEY = 'appBackupRecovery';
export interface BackupManifest {
  format: 'infinite-afflatus-app-index-backup';
  version: 1;
  schemaVersion: 1;
  id: string;
  createdAt: string;
  appVersion: string;
  anchor: BackupAnchor;
  bytes: number;
  sha256: string;
  projectCount: number;
  saveCount: number;
}
export interface ApplicationSnapshot {
  root: string;
  settings: Record<string, unknown>;
  projects: ProjectSummary[];
  jobs: SaveJob[];
}
export function readApplicationSnapshot(file: string): ApplicationSnapshot {
  const db = openDatabase(file, true);
  try {
    const root = verifyAppStore(db);
    return {
      root,
      settings: Object.fromEntries(
        db
          .prepare('SELECT key, value FROM settings')
          .all()
          .map((row) => [
            String(row.key),
            row.key === 'root' ? row.value : JSON.parse(String(row.value)),
          ]),
      ),
      projects: db
        .prepare('SELECT payload FROM projects')
        .all()
        .map((row) => JSON.parse(String(row.payload))),
      jobs: db
        .prepare('SELECT payload FROM saves')
        .all()
        .map((row) => JSON.parse(String(row.payload))),
    };
  } finally {
    db.close();
  }
}
export function assertStableMigration(snapshot: ApplicationSnapshot) {
  const migration = snapshot.settings.migration as
    | { status?: { phase?: unknown } }
    | undefined;
  if (
    migration &&
    !['completed', 'failed', 'cancelled'].includes(
      String(migration.status?.phase),
    )
  )
    throw new Error('备份包含未完成或无法识别的目录迁移，不能自动恢复');
}
function manifest(value: unknown): BackupManifest {
  const item = value as BackupManifest;
  if (
    item?.format !== 'infinite-afflatus-app-index-backup' ||
    item.version !== 1 ||
    item.schemaVersion !== 1 ||
    !UUID.test(item.id) ||
    typeof item.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(item.createdAt)) ||
    typeof item.appVersion !== 'string' ||
    item.appVersion.length > 100 ||
    !Number.isSafeInteger(item.bytes) ||
    item.bytes <= 0 ||
    item.bytes > MAX_DATABASE_BYTES ||
    typeof item.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(item.sha256) ||
    !Number.isSafeInteger(item.projectCount) ||
    item.projectCount < 0 ||
    !Number.isSafeInteger(item.saveCount) ||
    item.saveCount < 0
  )
    throw new Error('应用索引备份清单损坏或版本不受支持');
  decodeAnchor(item.anchor);
  return item;
}
export function backupInfo(
  item: BackupManifest,
  reason: string | null,
): AppBackupInfo {
  return {
    id: item.id,
    createdAt: item.createdAt,
    appVersion: item.appVersion,
    root: item.anchor.root.path,
    projectCount: item.projectCount,
    saveCount: item.saveCount,
    bytes: item.bytes,
    sha256: item.sha256,
    restorable: reason === null,
    reason,
  };
}
export async function readBackup(userData: string, id: string) {
  if (!UUID.test(id)) throw new Error('应用备份标识无效');
  const directory = join(userData, BACKUP_DIRECTORY);
  await directoryIdentity(directory);
  const root = await directoryIdentity(join(directory, id));
  const item = manifest(await readJson(join(root.path, 'manifest.json')));
  if (item.id !== id || item.anchor.userData.path !== userData)
    throw new Error('应用备份来源与当前资料目录不符');
  const database = await safeFile(root.path, 'app.sqlite');
  for (const suffix of ['-wal', '-shm', '-journal'])
    if (await info(`${database}${suffix}`))
      throw new Error('应用备份包含未登记的 SQLite 日志，未读取');
  const file = await info(database);
  if (!file || file.size !== BigInt(item.bytes))
    throw new Error('应用备份大小与清单不符');
  const digest = await fingerprint(database);
  if (digest.sha256 !== item.sha256 || digest.size !== item.bytes)
    throw new Error('应用备份校验失败，原文件已保留');
  const snapshot = readApplicationSnapshot(database);
  if (
    snapshot.root !== item.anchor.root.path ||
    snapshot.projects.length !== item.projectCount ||
    snapshot.jobs.length !== item.saveCount
  )
    throw new Error('应用备份数据库与清单不一致');
  await verifyDirectory(root);
  return { manifest: item, snapshot, database, directory: root };
}
export async function readRecoveryReport(
  userData: string,
  value: unknown,
): Promise<AppBackupRecoveryReport | null> {
  if (value === null || value === undefined) return null;
  const report = value as AppBackupRecoveryReport;
  if (
    !UUID.test(report.backupId) ||
    typeof report.restoredAt !== 'string' ||
    !Number.isFinite(Date.parse(report.restoredAt)) ||
    typeof report.retainedDirectory !== 'string' ||
    dirname(report.retainedDirectory) !== join(userData, RETAINED_DIRECTORY) ||
    !UUID.test(basename(report.retainedDirectory)) ||
    !Number.isSafeInteger(report.retainedJobCount) ||
    report.retainedJobCount < 0 ||
    !Number.isSafeInteger(report.retainedFileCount) ||
    report.retainedFileCount < 0 ||
    typeof report.warning !== 'string'
  )
    throw new Error('应用恢复保留记录无效，原保留资料未删除');
  await directoryIdentity(join(userData, RETAINED_DIRECTORY));
  await directoryIdentity(report.retainedDirectory);
  return report;
}

export async function backupCatalog(
  input: string,
  recoveryValue?: unknown,
): Promise<AppBackupList> {
  const userData = await realpath(input);
  const directory = join(userData, BACKUP_DIRECTORY);
  const result: AppBackupList = {
    directory,
    backups: [],
    issues: [],
    recovery: null,
  };
  try {
    result.recovery = await readRecoveryReport(userData, recoveryValue);
  } catch (error) {
    result.issues.push({
      file: 'appBackupRecovery',
      message: errorMessage(error),
    });
  }
  if (!(await info(directory))) return result;
  await directoryIdentity(directory);
  let anchor: BackupAnchor | null = null;
  let anchorError: string | null = null;
  try {
    anchor = await stableAnchor(userData);
  } catch (error) {
    anchorError = errorMessage(error);
  }
  const entries = await readdir(directory);
  if (entries.length > 1024)
    throw new Error('应用备份目录项目过多，未自动清理');
  for (const id of entries) {
    if (!UUID.test(id)) {
      result.issues.push({
        file: id,
        message: '未完成或无法识别的备份资料已保留，未自动清理',
      });
      continue;
    }
    try {
      const item = await readBackup(userData, id);
      let reason = anchorError;
      if (anchor && !sameAnchor(anchor, item.manifest.anchor))
        reason = '备份后项目目录代际已变化，不能恢复旧索引';
      try {
        assertStableMigration(item.snapshot);
      } catch (error) {
        reason = errorMessage(error);
      }
      result.backups.push(backupInfo(item.manifest, reason));
    } catch (error) {
      result.issues.push({ file: id, message: errorMessage(error) });
    }
  }
  result.backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return result;
}

export interface BackupProjectEvidence {
  directory: DirectoryIdentity;
  sha256: string;
}
