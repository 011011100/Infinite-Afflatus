import type { DatabaseSync } from 'node:sqlite';
import {
  applyCanvasPatch,
  type CanvasDocument,
  type CanvasPatch,
  reconcileCanvas,
} from '../../shared/canvas/model';
import {
  emptyGenerationDraft,
  type GenerationDraft,
} from '../../shared/generation/draft';
import type {
  Asset,
  ProjectSnapshot,
  ProjectSummary,
  Viewport,
} from '../../shared/models';
import type { ProxyRecord } from '../media/proxy-record';
import { openDatabase, transaction } from '../storage/database';

const APPLICATION_ID = 0x49414646;
const VERSION = 1;

export function createProjectDatabase(
  file: string,
  project: ProjectSummary,
): void {
  const db = openDatabase(file);
  try {
    db.exec(`
      PRAGMA application_id = ${APPLICATION_ID}; PRAGMA user_version = ${VERSION};
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE assets (id TEXT PRIMARY KEY, result_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
    `);
    transaction(db, () => {
      setValue(db, 'project', project);
      setValue(db, 'viewport', { x: 0, y: 0, zoom: 1 });
    });
  } finally {
    db.close();
  }
}

function withProject<T>(
  file: string,
  write: boolean,
  operation: (db: DatabaseSync) => T,
): T {
  // Inspect the format before applying any writable PRAGMAs.
  const reader = openDatabase(file, true);
  try {
    if (
      reader.prepare('PRAGMA application_id').get()?.application_id !==
      APPLICATION_ID
    ) {
      throw new Error('这不是 Infinite Afflatus 项目');
    }
    if (reader.prepare('PRAGMA user_version').get()?.user_version !== VERSION) {
      throw new Error('项目版本不受支持，请使用对应版本的应用');
    }
    if (!write) return operation(reader);
  } finally {
    reader.close();
  }
  const db = openDatabase(file);
  try {
    return transaction(db, () => operation(db));
  } finally {
    db.close();
  }
}

function value<T>(db: DatabaseSync, key: string): T {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
  if (!row) throw new Error('项目数据不完整');
  return JSON.parse(String(row.value)) as T;
}

function setValue(db: DatabaseSync, key: string, data: unknown): void {
  db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)').run(
    key,
    JSON.stringify(data),
  );
}

export function readProject(file: string): ProjectSnapshot {
  return withProject(file, false, snapshot);
}

function generationDraft(db: DatabaseSync): GenerationDraft {
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = 'generation-draft'")
    .get();
  return row
    ? (JSON.parse(String(row.value)) as GenerationDraft)
    : emptyGenerationDraft();
}

export function readGenerationDraft(file: string): GenerationDraft {
  return withProject(file, false, generationDraft);
}

export function writeGenerationDraft(
  file: string,
  draft: GenerationDraft,
): { draft: GenerationDraft; project: ProjectSummary } {
  return withProject(file, true, (db) => {
    if (generationDraft(db).revision !== draft.revision)
      throw new Error('生成草稿已在其他页面更新，请重新打开后编辑');
    const saved = { ...draft, revision: draft.revision + 1 };
    const project = value<ProjectSummary>(db, 'project');
    project.updatedAt = new Date().toISOString();
    setValue(db, 'generation-draft', saved);
    setValue(db, 'project', project);
    return { draft: saved, project };
  });
}

/** Optional derived-media metadata keeps existing version-1 projects readable. */
export function readProxies(file: string): ProxyRecord[] {
  return withProject(file, false, (db) => {
    const row = db
      .prepare("SELECT value FROM metadata WHERE key = 'proxies'")
      .get();
    return row ? (JSON.parse(String(row.value)) as ProxyRecord[]) : [];
  });
}

export function recordProxy(file: string, proxy: ProxyRecord): void {
  withProject(file, true, (db) => {
    const row = db
      .prepare("SELECT value FROM metadata WHERE key = 'proxies'")
      .get();
    const records = row ? (JSON.parse(String(row.value)) as ProxyRecord[]) : [];
    // Keep earlier registered files in the manifest, including older proxy versions.
    setValue(db, 'proxies', [
      ...records.filter((item) => item.relativePath !== proxy.relativePath),
      proxy,
    ]);
  });
}

function snapshot(db: DatabaseSync): ProjectSnapshot {
  const assets = db
    .prepare('SELECT payload FROM assets ORDER BY rowid')
    .all()
    .map((row) => JSON.parse(String(row.payload)) as Asset);
  const stored = db
    .prepare("SELECT value FROM metadata WHERE key = 'canvas'")
    .get();
  return {
    project: value<ProjectSummary>(db, 'project'),
    viewport: value<Viewport>(db, 'viewport'),
    assets,
    canvas: reconcileCanvas(
      stored ? (JSON.parse(String(stored.value)) as CanvasDocument) : undefined,
      assets,
    ),
  };
}

export function patchProjectCanvas(
  file: string,
  patch: CanvasPatch,
): ProjectSnapshot {
  return withProject(file, true, (db) => {
    const current = snapshot(db);
    current.canvas = applyCanvasPatch(current.canvas, patch);
    current.project.updatedAt = new Date().toISOString();
    setValue(db, 'canvas', current.canvas);
    setValue(db, 'project', current.project);
    return current;
  });
}

export function verifyProjectDatabase(file: string): void {
  withProject(file, false, (db) => {
    const rows = db.prepare('PRAGMA quick_check').all();
    if (
      rows.length !== 1 ||
      rows[0]?.quick_check !== 'ok' ||
      db.prepare('PRAGMA foreign_key_check').all().length
    ) {
      throw new Error('项目数据库完整性检查未通过');
    }
  });
}

export function updateProject(
  file: string,
  changes: { name?: string; viewport?: Viewport },
): ProjectSummary {
  return withProject(file, true, (db) => {
    const project = value<ProjectSummary>(db, 'project');
    if (changes.name !== undefined) project.name = changes.name;
    if (changes.viewport) setValue(db, 'viewport', changes.viewport);
    project.updatedAt = new Date().toISOString();
    setValue(db, 'project', project);
    return project;
  });
}

export function recordAsset(
  file: string,
  resultKey: string,
  asset: Asset,
): ProjectSummary {
  return withProject(file, true, (db) => {
    const existing = db
      .prepare('SELECT payload FROM assets WHERE result_key = ?')
      .get(resultKey);
    if (existing) {
      const prior = JSON.parse(String(existing.payload)) as Asset;
      if (prior.id !== asset.id || prior.sha256 !== asset.sha256)
        throw new Error('生成结果标识发生冲突');
    } else {
      db.prepare('INSERT INTO assets VALUES (?, ?, ?)').run(
        asset.id,
        resultKey,
        JSON.stringify(asset),
      );
    }
    const project = value<ProjectSummary>(db, 'project');
    project.updatedAt = new Date().toISOString();
    setValue(db, 'project', project);
    return project;
  });
}
