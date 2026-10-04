import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectSummary } from '../../shared/models';
import { validateProjectSchema } from './project-schema';

export type ProjectIdentity = Pick<ProjectSummary, 'id' | 'folder'>;

export function verifyProjectPath(file: string): void {
  const info = lstatSync(file);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    realpathSync(file) !== resolve(file)
  )
    throw new Error('项目数据库路径已变化或包含符号链接，请放回原文件后重试');
}

export function verifyProjectFormat(db: DatabaseSync): void {
  if (db.prepare('PRAGMA application_id').get()?.application_id !== 0x49414646)
    throw new Error('这不是 Infinite Afflatus 项目');
  if (db.prepare('PRAGMA user_version').get()?.user_version !== 1)
    throw new Error('项目版本不受支持，请使用对应版本的应用');
}

/** Always use the indexed identity, never one read from the file being checked. */
export function verifyProjectIdentity(
  db: DatabaseSync,
  expected: ProjectIdentity,
): void {
  validateProjectSchema(db);
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = 'project'")
    .get();
  if (!row) throw new Error('项目数据不完整');
  const project = JSON.parse(String(row.value)) as ProjectSummary | null;
  if (project?.id !== expected.id || project?.folder !== expected.folder)
    throw new Error(
      '项目文件与索引不匹配，请放回此项目原有的 project.sqlite 后重试',
    );
  const viewport = db
    .prepare("SELECT value FROM metadata WHERE key = 'viewport'")
    .get();
  if (!viewport) throw new Error('项目数据不完整');
  const value = JSON.parse(String(viewport.value));
  if (
    !value ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !Number.isFinite(value.zoom) ||
    Math.abs(value.x) > 1e8 ||
    Math.abs(value.y) > 1e8 ||
    value.zoom < 0.25 ||
    value.zoom > 2
  )
    throw new Error('项目画布位置数据无效');
}

export function verifyProjectIntegrity(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA quick_check').all();
  if (
    rows.length !== 1 ||
    rows[0]?.quick_check !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').all().length
  )
    throw new Error('项目数据库完整性检查未通过');
}
