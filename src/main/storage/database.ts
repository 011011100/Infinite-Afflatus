import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

/** SQLite mode=rw atomically refuses to create a missing existing database. */
export function existingDatabaseLocation(path: string): string {
  const location = pathToFileURL(path);
  if (location.hostname) {
    location.pathname = `//${location.hostname}${location.pathname}`;
    location.hostname = '';
  }
  location.searchParams.set('mode', 'rw');
  return location.href;
}

export function openDatabase(
  path: string,
  readOnly = false,
  beforeWrite?: (db: DatabaseSync) => void,
): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly, timeout: 5_000 });
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;');
    if (!readOnly) {
      // Validate the actual writable connection before changing the file's journal mode.
      beforeWrite?.(db);
      db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;');
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
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
