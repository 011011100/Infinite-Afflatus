import type { DatabaseSync } from 'node:sqlite';
import type { ProjectSummary, SaveJob } from '../../shared/models';
import { openDatabase, transaction } from './database';

/** Fixed userData database: routing, queue and recovery journal survive a library move. */
export class AppStore {
  private readonly db: DatabaseSync;

  constructor(file: string, defaultRoot: string) {
    this.db = openDatabase(file);
    const version = Number(
      this.db.prepare('PRAGMA user_version').get()?.user_version,
    );
    if (version > 1) {
      this.db.close();
      throw new Error('应用数据库版本较新，请使用对应版本打开');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS saves (id TEXT PRIMARY KEY, result_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    this.db
      .prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)')
      .run('root', defaultRoot);
  }

  get root(): string {
    return this.get<string>('root') ?? '';
  }

  get<T>(key: string): T | null {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key);
    if (!row) return null;
    // Root was intentionally stored as a plain path on first creation.
    return (key === 'root' ? row.value : JSON.parse(String(row.value))) as T;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)')
      .run(key, key === 'root' ? String(value) : JSON.stringify(value));
  }

  projects(): ProjectSummary[] {
    return this.db
      .prepare('SELECT payload FROM projects')
      .all()
      .map((row) => JSON.parse(String(row.payload)) as ProjectSummary)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  putProject(project: ProjectSummary): void {
    this.db
      .prepare('INSERT OR REPLACE INTO projects VALUES (?, ?)')
      .run(project.id, JSON.stringify(project));
  }

  jobs(): SaveJob[] {
    return this.db
      .prepare('SELECT payload FROM saves ORDER BY rowid DESC')
      .all()
      .map((row) => JSON.parse(String(row.payload)) as SaveJob);
  }

  job(id: string): SaveJob {
    const row = this.db
      .prepare('SELECT payload FROM saves WHERE id = ?')
      .get(id);
    if (!row) throw new Error('保存任务不存在');
    return JSON.parse(String(row.payload)) as SaveJob;
  }

  putJob(job: SaveJob): void {
    this.db
      .prepare(
        `INSERT INTO saves VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`,
      )
      .run(job.id, `${job.projectId}:${job.resultKey}`, JSON.stringify(job));
  }

  commitLocation(root: string, journal: unknown): void {
    transaction(this.db, () => {
      this.set('root', root);
      this.set('migration', journal);
    });
  }

  close(): void {
    this.db.close();
  }
}
