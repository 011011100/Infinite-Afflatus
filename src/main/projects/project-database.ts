import type { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
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
import {
  type ProjectEditDraftInput,
  projectEditDraftState,
} from '../../shared/project-edit-draft';
import type { ProxyRecord } from '../media/proxy-record';
import { openDatabase, transaction } from '../storage/database';
import {
  type ProjectIdentity,
  verifyProjectFormat,
  verifyProjectIdentity,
  verifyProjectIntegrity,
  verifyProjectPath,
} from './project-guard';

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

export function withProject<T>(
  file: string,
  write: boolean,
  operation: (db: DatabaseSync) => T,
  expected?: ProjectIdentity,
): T {
  const verify = (db: DatabaseSync) => {
    if (expected) verifyProjectPath(file);
    verifyProjectFormat(db);
    if (expected) verifyProjectIdentity(db, expected);
  };
  // Inspect the format before applying any writable PRAGMAs.
  const reader = openDatabase(file, true);
  try {
    verify(reader);
    if (!write) return operation(reader);
  } finally {
    reader.close();
  }
  // mode=rw removes SQLite's CREATE flag atomically. An existence check would
  // still recreate an empty file if the original disappeared after preflight.
  const location = pathToFileURL(file);
  if (location.hostname) {
    // SQLite accepts UNC paths in the path component without URI authority.
    location.pathname = `//${location.hostname}${location.pathname}`;
    location.hostname = '';
  }
  location.searchParams.set('mode', 'rw');
  const db = openDatabase(location.href, false, (db) => {
    verify(db);
    verifyProjectIntegrity(db);
  });
  try {
    return transaction(db, () => {
      // A preflight on another connection cannot authorize this write.
      verify(db);
      return operation(db);
    });
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

export function readProject(
  file: string,
  expected?: ProjectIdentity,
): ProjectSnapshot {
  return withProject(file, false, snapshot, expected);
}

function generationDraft(db: DatabaseSync): GenerationDraft {
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = 'generation-draft'")
    .get();
  return row
    ? (JSON.parse(String(row.value)) as GenerationDraft)
    : emptyGenerationDraft();
}

export function readGenerationDraft(
  file: string,
  expected?: ProjectIdentity,
): GenerationDraft {
  return withProject(file, false, generationDraft, expected);
}

export function writeGenerationDraft(
  file: string,
  draft: GenerationDraft,
  expected: ProjectIdentity,
): { draft: GenerationDraft; project: ProjectSummary } {
  return withProject(
    file,
    true,
    (db) => {
      if (generationDraft(db).revision !== draft.revision)
        throw new Error('生成草稿已在其他页面更新，请重新打开后编辑');
      const saved = { ...draft, revision: draft.revision + 1 };
      const project = value<ProjectSummary>(db, 'project');
      project.updatedAt = new Date().toISOString();
      setValue(db, 'generation-draft', saved);
      setValue(db, 'project', project);
      return { draft: saved, project };
    },
    expected,
  );
}

/** Optional derived-media metadata keeps existing version-1 projects readable. */
export function readProxies(
  file: string,
  expected?: ProjectIdentity,
): ProxyRecord[] {
  return withProject(
    file,
    false,
    (db) => {
      const row = db
        .prepare("SELECT value FROM metadata WHERE key = 'proxies'")
        .get();
      return row ? (JSON.parse(String(row.value)) as ProxyRecord[]) : [];
    },
    expected,
  );
}

export function recordProxy(
  file: string,
  proxy: ProxyRecord,
  expected: ProjectIdentity,
): void {
  withProject(
    file,
    true,
    (db) => {
      const row = db
        .prepare("SELECT value FROM metadata WHERE key = 'proxies'")
        .get();
      const records = row
        ? (JSON.parse(String(row.value)) as ProxyRecord[])
        : [];
      // Keep earlier registered files in the manifest, including older proxy versions.
      setValue(db, 'proxies', [
        ...records.filter((item) => item.relativePath !== proxy.relativePath),
        proxy,
      ]);
    },
    expected,
  );
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
  expected: ProjectIdentity,
): ProjectSnapshot {
  return withProject(
    file,
    true,
    (db) => {
      const current = snapshot(db);
      current.canvas = applyCanvasPatch(current.canvas, patch);
      current.project.updatedAt = new Date().toISOString();
      setValue(db, 'canvas', current.canvas);
      setValue(db, 'project', current.project);
      return current;
    },
    expected,
  );
}

/** A narrow recovery transaction never replaces unrelated cards, media, viewport or workspace. */
export function restoreProjectEditDatabase(
  file: string,
  draft: ProjectEditDraftInput,
  expected: ProjectIdentity,
): ProjectSnapshot {
  return withProject(
    file,
    true,
    (db) => {
      const current = snapshot(db);
      const state = projectEditDraftState(draft, current);
      if (state === 'conflict')
        throw new Error(
          '项目名称、裁剪或原素材与恢复基线不同，已保留副本；未覆盖项目',
        );
      if (state === 'submitted') return current;
      if (draft.kind === 'name') {
        // ProjectService validates the raw target before entering this transaction.
        current.project.name = draft.target.trim();
      } else {
        const before = current.canvas.cards.find(
          (card) => card.id === draft.baseline.id,
        );
        if (!before) throw new Error('原裁剪卡片不存在，恢复副本已保留');
        current.canvas = applyCanvasPatch(current.canvas, {
          before: [before],
          after: [draft.target],
        });
        setValue(db, 'canvas', current.canvas);
      }
      current.project.updatedAt = new Date().toISOString();
      setValue(db, 'project', current.project);
      return current;
    },
    expected,
  );
}

export function verifyProjectDatabase(
  file: string,
  expected?: ProjectIdentity,
): void {
  withProject(file, false, verifyProjectIntegrity, expected);
}

export function updateProject(
  file: string,
  changes: { name?: string; viewport?: Viewport },
  expected: ProjectIdentity,
): ProjectSummary {
  return withProject(
    file,
    true,
    (db) => {
      const project = value<ProjectSummary>(db, 'project');
      if (changes.name !== undefined) project.name = changes.name;
      if (changes.viewport) setValue(db, 'viewport', changes.viewport);
      project.updatedAt = new Date().toISOString();
      setValue(db, 'project', project);
      return project;
    },
    expected,
  );
}

export function recordAsset(
  file: string,
  resultKey: string,
  asset: Asset,
  expected: ProjectIdentity,
): ProjectSummary {
  return withProject(
    file,
    true,
    (db) => {
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
    },
    expected,
  );
}
