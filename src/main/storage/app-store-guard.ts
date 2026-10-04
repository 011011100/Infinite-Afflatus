import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './database';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AppStoreIdentity {
  dev: number;
  ino: number;
}

export function verifyAppStorePath(
  file: string,
  expected?: AppStoreIdentity,
): AppStoreIdentity {
  const info = lstatSync(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (expected && (info.dev !== expected.dev || info.ino !== expected.ino))
  )
    throw new Error('应用数据库路径已变化或不是普通文件，请放回原文件后重试');
  return info;
}

/** Existing profiles must never be repaired by CREATE IF NOT EXISTS or default settings. */
export function verifyAppStore(db: DatabaseSync): string {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (version !== 1)
    throw new Error(
      version > 1
        ? '应用数据库版本较新，请使用对应版本打开'
        : '应用数据库为空或版本不受支持，未创建替代库',
    );
  const schema = db
    .prepare(
      "SELECT name, type FROM sqlite_schema WHERE substr(name, 1, 7) <> 'sqlite_'",
    )
    .all();
  if (
    schema.length !== 3 ||
    schema.some(
      (row) =>
        row.type !== 'table' ||
        !['settings', 'projects', 'saves'].includes(String(row.name)),
    )
  )
    throw new Error('应用数据库表结构不完整或不受支持，未修改原文件');
  for (const [table, names, unique] of [
    ['settings', ['key', 'value'], 'key'],
    ['projects', ['id', 'payload'], 'id'],
    ['saves', ['id', 'result_key', 'payload'], 'result_key'],
  ] as const) {
    const columns = db.prepare(`PRAGMA table_xinfo(${table})`).all();
    if (
      columns.length !== names.length ||
      columns.some(
        (column, index) =>
          column.name !== names[index] ||
          String(column.type).toUpperCase() !== 'TEXT' ||
          column.hidden !== 0 ||
          column.pk !== (index === 0 ? 1 : 0) ||
          column.notnull !== (index === 0 ? 0 : 1),
      )
    )
      throw new Error('应用数据库字段不完整或不受支持');
    const indices = db
      .prepare(
        'SELECT name, "unique", origin, partial FROM pragma_index_list(?)',
      )
      .all(table);
    const constraints =
      table === 'saves'
        ? [
            { column: 'id', origin: 'pk' },
            { column: unique, origin: 'u' },
          ]
        : [{ column: unique, origin: 'pk' }];
    if (
      indices.length !== constraints.length ||
      constraints.some(
        (constraint) =>
          !indices.some((index) => {
            const fields = db
              .prepare('SELECT name FROM pragma_index_info(?)')
              .all(String(index.name));
            return (
              index.unique === 1 &&
              index.partial === 0 &&
              index.origin === constraint.origin &&
              fields.length === 1 &&
              fields[0]?.name === constraint.column
            );
          }),
      )
    )
      throw new Error('应用数据库缺少必须的主键或唯一约束');
  }
  const integrity = db.prepare('PRAGMA quick_check').all();
  if (
    integrity.length !== 1 ||
    integrity[0]?.quick_check !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').all().length
  )
    throw new Error('应用数据库完整性检查未通过');
  const settings = db.prepare('SELECT key, value FROM settings').all();
  const root = settings.find((row) => row.key === 'root')?.value;
  if (
    typeof root !== 'string' ||
    !root.trim() ||
    !isAbsolute(root) ||
    root.includes('\0')
  )
    throw new Error('应用数据库缺少有效的原项目保存目录，未改用默认目录');
  for (const row of settings) {
    if (row.key !== 'root') JSON.parse(String(row.value));
  }
  for (const row of db.prepare('SELECT id, payload FROM projects').all()) {
    const value = JSON.parse(String(row.payload));
    if (
      !value ||
      value.id !== row.id ||
      typeof value.id !== 'string' ||
      !uuid.test(value.id) ||
      value.folder !== value.id ||
      typeof value.name !== 'string' ||
      typeof value.updatedAt !== 'string'
    )
      throw new Error('应用数据库中的项目索引无效');
  }
  for (const row of db
    .prepare('SELECT id, result_key, payload FROM saves')
    .all()) {
    const value = JSON.parse(String(row.payload));
    if (
      !value ||
      value.id !== row.id ||
      typeof value.id !== 'string' ||
      !uuid.test(value.id) ||
      typeof value.projectId !== 'string' ||
      !uuid.test(value.projectId) ||
      typeof value.resultKey !== 'string' ||
      typeof value.extension !== 'string' ||
      !/^[a-z0-9]{1,10}$/.test(value.extension) ||
      !['video', 'image', 'audio', 'text'].includes(value.kind) ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0 ||
      typeof value.sha256 !== 'string' ||
      !/^(?:|[0-9a-f]{64})$/.test(value.sha256) ||
      `${value.projectId}:${value.resultKey}` !== row.result_key ||
      !['receiving', 'ready', 'saving', 'saved', 'failed'].includes(
        value.status,
      )
    )
      throw new Error('应用数据库中的保存队列无效');
  }
  return root;
}

/** Safe for startup recovery UI: no initialization, writable connection or default root. */
export function readAppStoreRoot(
  file: string,
  expected?: AppStoreIdentity,
): string {
  const identity = verifyAppStorePath(file, expected);
  const db = openDatabase(file, true);
  try {
    verifyAppStorePath(file, identity);
    return verifyAppStore(db);
  } finally {
    db.close();
  }
}
