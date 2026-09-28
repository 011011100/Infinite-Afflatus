import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path: string, readOnly = false): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly, timeout: 5_000 });
  db.exec('PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;');
  if (!readOnly)
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;');
  return db;
}

export function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
