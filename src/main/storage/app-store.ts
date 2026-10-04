import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { backup, type DatabaseSync } from 'node:sqlite';
import type { ProjectSummary, SaveJob } from '../../shared/models';
import {
  type AppStoreIdentity,
  readAppStoreRoot,
  verifyAppStore,
  verifyAppStorePath,
} from './app-store-guard';
import {
  existingDatabaseLocation,
  openDatabase,
  transaction,
} from './database';

/** Fixed userData database: routing, queue and recovery journal survive a library move. */
export class AppStore {
  private readonly db: DatabaseSync;
  private readonly sourceIdentity: AppStoreIdentity;
  private snapshots = new Set<Promise<void>>();
  private closing: Promise<void> | null = null;

  constructor(
    private readonly file: string,
    defaultRoot: string,
    options: { mode?: 'create' | 'existing'; expected?: AppStoreIdentity } = {},
  ) {
    let mode = options.mode;
    if (!mode) {
      try {
        lstatSync(file);
        mode = 'existing';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mode = 'create';
      }
    }
    if (mode === 'create') closeSync(openSync(file, 'wx', 0o600));
    const identity = verifyAppStorePath(file, options.expected);
    if (mode === 'existing') readAppStoreRoot(file, identity);
    const db = openDatabase(
      existingDatabaseLocation(file),
      false,
      (connection) => {
        verifyAppStorePath(file, identity);
        if (mode === 'existing') verifyAppStore(connection);
        else if (
          connection.prepare('PRAGMA user_version').get()?.user_version !== 0 ||
          connection.prepare('SELECT name FROM sqlite_schema').all().length
        )
          throw new Error('新应用数据库文件已被替换，未覆盖现有内容');
      },
    );
    try {
      if (mode === 'create')
        transaction(db, () => {
          db.exec(`
          CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE projects (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
          CREATE TABLE saves (id TEXT PRIMARY KEY, result_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
          PRAGMA user_version = 1;
        `);
          db.prepare('INSERT INTO settings VALUES (?, ?)').run(
            'root',
            defaultRoot,
          );
          verifyAppStore(db);
        });
      this.db = db;
      this.sourceIdentity = identity;
    } catch (error) {
      db.close();
      throw error;
    }
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

  hasSetting(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key);
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

  deleteJob(id: string, expectedPayload: string): void {
    const result = this.db
      .prepare('DELETE FROM saves WHERE id = ? AND payload = ?')
      .run(id, expectedPayload);
    if (result.changes !== 1) throw new Error('保存任务已变化，未移除任务记录');
  }

  commitLocation(root: string, journal: unknown, generation?: unknown): void {
    transaction(this.db, () => {
      this.set('root', root);
      this.set('migration', journal);
      if (generation !== undefined) this.set('appBackupGeneration', generation);
    });
  }

  /** Binds first-time anchor initialization to the exact original file and logical contents. */
  backupSourceEvidence() {
    verifyAppStorePath(this.file, this.sourceIdentity);
    const stat = lstatSync(this.file, { bigint: true });
    const hash = createHash('sha256');
    transaction(this.db, () => {
      verifyAppStore(this.db);
      for (const [table, order] of [
        ['settings', 'key'],
        ['projects', 'id'],
        ['saves', 'id'],
      ]) {
        hash.update(table ?? '');
        for (const row of this.db
          .prepare(`SELECT * FROM ${table} ORDER BY ${order}`)
          .iterate())
          hash.update(JSON.stringify(row));
      }
    });
    verifyAppStorePath(this.file, this.sourceIdentity);
    return {
      dev: String(stat.dev),
      ino: String(stat.ino),
      birthtimeNs: String(stat.birthtimeNs),
      sha256: hash.digest('hex'),
    };
  }

  /** The destination must be inside the caller's exclusively created temporary directory. */
  snapshot(file: string): Promise<void> {
    if (this.closing) return Promise.reject(new Error('应用数据库正在关闭'));
    const operation = (async () => {
      const existing = await lstat(file).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        },
      );
      if (existing) throw new Error('备份临时数据库已存在，未覆盖');
      verifyAppStorePath(this.file, this.sourceIdentity);
      verifyAppStore(this.db);
      await backup(this.db, file);
      verifyAppStorePath(this.file, this.sourceIdentity);
    })().finally(() => this.snapshots.delete(operation));
    this.snapshots.add(operation);
    return operation;
  }

  close(): Promise<void> {
    if (!this.closing) {
      if (!this.snapshots.size) {
        this.db.close();
        this.closing = Promise.resolve();
      } else
        this.closing = Promise.allSettled([...this.snapshots]).then(() =>
          this.db.close(),
        );
    }
    return this.closing;
  }
}
