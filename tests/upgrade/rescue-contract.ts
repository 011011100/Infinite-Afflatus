import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectEditDraftService } from '../../src/main/drafts/project-edit-draft-service';
import { RescueImportService } from '../../src/main/drafts/rescue-import-service';
import { WorkspaceDraftService } from '../../src/main/drafts/workspace-draft-service';
import { GenerationService } from '../../src/main/generation/generation-service';
import { ProjectService } from '../../src/main/projects/project-service';
import { AppStore } from '../../src/main/storage/app-store';
import { safeFile } from '../../src/main/storage/files';
import { WriteGate } from '../../src/main/storage/write-gate';
import type { GenerationWorkspace } from '../../src/shared/generation/workspace';
import type { ProjectSnapshot } from '../../src/shared/models';
import type {
  ProjectEditDraftList,
  ProjectEditDraftRecord,
} from '../../src/shared/project-edit-draft';
import type { RescueImportResult } from '../../src/shared/rescue-import';
import type {
  WorkspaceDraftList,
  WorkspaceDraftRecord,
} from '../../src/shared/workspace-draft';
import { withoutTimestamp } from './checks';
import { assertOriginalFiles, fileHash, type HistoricalData } from './history';

export type HistoricalRescueRecord =
  | WorkspaceDraftRecord
  | ProjectEditDraftRecord;
export interface HistoricalRescue {
  writerCommit: string;
  mode: string;
  record: HistoricalRescueRecord;
  exportPath: string;
  retained: { file: string; sha256: string }[];
  settings: { key: string; value: string }[];
  disk: ProjectSnapshot;
  workspace: GenerationWorkspace;
  workspaceDrafts: WorkspaceDraftList;
  editDrafts: ProjectEditDraftList;
  independentDrafts: WorkspaceDraftList;
}
export interface RescueUpgradeContract {
  app: string;
  defaultRoot: string;
  expected: HistoricalData;
  history: HistoricalRescue;
  wanted: ProjectSnapshot;
  wantedWorkspace: GenerationWorkspace;
  imported: RescueImportResult;
  retainedImport: HistoricalRescueRecord | null;
}
export const isWorkspace = (
  record: HistoricalRescueRecord,
): record is WorkspaceDraftRecord =>
  record.format === 'infinite-afflatus-workspace-draft';

export function openRescueServices(app: string, defaultRoot: string) {
  const store = new AppStore(join(app, 'app.sqlite'), defaultRoot);
  const gate = new WriteGate();
  const projects = new ProjectService(store, gate);
  const generation = new GenerationService(projects, store, gate);
  const drafts = new WorkspaceDraftService(app);
  const edits = new ProjectEditDraftService(app);
  const imports = new RescueImportService(drafts, edits, {
    summary: (id) => projects.summary(id),
    read: (id) => projects.open(id),
    readWorkspace: (id) => generation.readWorkspace(id),
    databasePath: (id) => projects.databasePath(id),
    resolveAsset: (id, asset) =>
      safeFile(
        join(store.root, projects.summary(id).folder),
        asset.relativePath,
      ),
    assertAvailable: () => {
      if (gate.isBlocked) throw new Error('Test project gate is blocked');
    },
    run: (operation) => gate.run(operation),
  });
  return {
    store,
    projects,
    generation,
    drafts,
    edits,
    imports,
    close: async () => {
      await imports.close();
      await Promise.all([drafts.close(), edits.close()]);
      store.close();
    },
  };
}

export async function assertRescuePreserved(
  contract: RescueUpgradeContract,
  services: ReturnType<typeof openRescueServices>,
) {
  const {
    app,
    defaultRoot,
    expected,
    history,
    wanted,
    wantedWorkspace,
    imported,
    retainedImport,
  } = contract;
  const [original, independent] = expected.projects;
  assert.ok(original && independent);
  const { store, projects, generation, drafts, edits } = services;
  assert.equal(store.root, expected.root);
  assert.deepEqual(
    store.jobs(),
    expected.jobs,
    'Import/recovery must not execute the historical ready queue',
  );
  assert.equal(store.job(expected.queued.id).status, 'ready');
  assert.deepEqual(
    store
      .projects()
      .map((p) => p.id)
      .sort(),
    [
      original.project.id,
      independent.project.id,
      expected.pendingProject.id,
    ].sort(),
  );
  assert.deepEqual(
    withoutTimestamp(await projects.open(original.project.id)),
    withoutTimestamp(wanted),
  );
  assert.deepEqual(
    await generation.readWorkspace(original.project.id),
    wantedWorkspace,
  );
  assert.deepEqual(await generation.read(original.project.id), expected.draft);
  assert.deepEqual(await projects.open(independent.project.id), independent);
  assert.deepEqual(
    await drafts.list(independent.project.id),
    history.independentDrafts,
  );
  for (const [actual, old] of [
    [await drafts.list(original.project.id), history.workspaceDrafts],
    [await edits.list(original.project.id), history.editDrafts],
  ] as const) {
    assert.deepEqual(actual.issues, old.issues);
    assert.deepEqual(
      actual.drafts
        .filter((draft) => draft.sessionId !== imported.key.sessionId)
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
      [...old.drafts].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    );
    const added = actual.drafts.filter(
      (draft) => draft.sessionId === imported.key.sessionId,
    );
    if (added.length) assert.deepEqual(added, [retainedImport]);
  }
  const folder =
    imported.kind === 'workspace' ? 'workspace-drafts' : 'project-edit-drafts';
  const importedFile = join(
    app,
    folder,
    `${original.project.id}.${imported.key.sessionId}.json`,
  );
  if (retainedImport)
    assert.deepEqual(
      JSON.parse(await readFile(importedFile, 'utf8')),
      retainedImport,
    );
  else await assert.rejects(access(importedFile), { code: 'ENOENT' });
  const db = new DatabaseSync(join(app, 'app.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(
      db
        .prepare('SELECT key,value FROM settings ORDER BY key')
        .all()
        .map((row) => ({ key: String(row.key), value: String(row.value) })),
      history.settings,
    );
  } finally {
    db.close();
  }
  for (const file of history.retained)
    assert.equal(
      await fileHash(file.file),
      file.sha256,
      `Retained file changed: ${file.file}`,
    );
  await assertOriginalFiles(expected);
  await assert.rejects(access(defaultRoot), { code: 'ENOENT' });
}
