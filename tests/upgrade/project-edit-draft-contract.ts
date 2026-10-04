import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectEditDraftService } from '../../src/main/drafts/project-edit-draft-service';
import { GenerationService } from '../../src/main/generation/generation-service';
import { ProjectService } from '../../src/main/projects/project-service';
import { AppStore } from '../../src/main/storage/app-store';
import { WriteGate } from '../../src/main/storage/write-gate';
import type { ProjectSnapshot } from '../../src/shared/models';
import type {
  ProjectEditDraftInput,
  ProjectEditDraftRecord,
} from '../../src/shared/project-edit-draft';
import { assertWorkspace, withoutTimestamp } from './checks';
import { assertOriginalFiles, fileHash, type HistoricalData } from './history';

export interface HistoricalProjectEditDraft {
  writerCommit: string;
  formatVersion: number;
  mode:
    | 'name-input'
    | 'name-last-submitted'
    | 'trim-input'
    | 'trim-last-submitted';
  input: ProjectEditDraftInput;
  record: ProjectEditDraftRecord;
  disk: ProjectSnapshot;
  file: string;
  fileSha256: string;
  retained: { file: string; sha256: string }[];
  independentRecord: ProjectEditDraftRecord;
  settings: { key: string; value: string }[];
  workspaceRaw: string;
}
export interface ProjectEditUpgradeContract {
  app: string;
  defaultRoot: string;
  expected: HistoricalData;
  history: HistoricalProjectEditDraft;
  wanted: ProjectSnapshot;
}

export function openProjectEditServices(app: string, defaultRoot: string) {
  const store = new AppStore(join(app, 'app.sqlite'), defaultRoot);
  const gate = new WriteGate();
  const projects = new ProjectService(store, gate);
  const drafts = new ProjectEditDraftService(app);
  const generation = new GenerationService(projects, store, gate);
  return {
    store,
    projects,
    drafts,
    generation,
    close: async () => {
      await drafts.close();
      store.close();
    },
  };
}

export async function assertProjectEditPreserved(
  contract: ProjectEditUpgradeContract,
  services: ReturnType<typeof openProjectEditServices>,
) {
  const { app, defaultRoot, expected, history, wanted } = contract;
  const [original, independent] = expected.projects;
  assert.ok(original && independent);
  const { store, projects, drafts, generation } = services;
  assert.equal(store.root, expected.root);
  assert.deepEqual(store.jobs(), expected.jobs);
  assert.equal(store.job(expected.queued.id).status, 'ready');
  assert.deepEqual(
    store
      .projects()
      .map((project) => project.id)
      .sort(),
    [
      original.project.id,
      independent.project.id,
      expected.pendingProject.id,
    ].sort(),
  );
  assert.equal(projects.summary(original.project.id).name, wanted.project.name);
  assert.deepEqual(
    withoutTimestamp(await projects.open(original.project.id)),
    withoutTimestamp(wanted),
  );
  assert.deepEqual(await projects.open(independent.project.id), independent);
  assertWorkspace(
    expected,
    await generation.readWorkspace(original.project.id),
  );
  assert.deepEqual(await generation.read(original.project.id), expected.draft);
  const db = new DatabaseSync(join(app, 'app.sqlite'), { readOnly: true });
  try {
    assert.deepEqual(
      db
        .prepare('SELECT key, value FROM settings ORDER BY key')
        .all()
        .map((row) => ({ key: String(row.key), value: String(row.value) })),
      history.settings,
    );
  } finally {
    db.close();
  }
  const projectDb = new DatabaseSync(
    join(expected.root, original.project.folder, 'project.sqlite'),
    { readOnly: true },
  );
  try {
    assert.equal(
      projectDb
        .prepare(
          "SELECT value FROM metadata WHERE key = 'generation-workspace'",
        )
        .get()?.value,
      history.workspaceRaw,
    );
  } finally {
    projectDb.close();
  }
  const list = await drafts.list(original.project.id);
  assert.deepEqual(list.drafts, []);
  assert.deepEqual(list.issues.map((issue) => issue.file).sort(), [
    `${original.project.id}.broken.json`,
    `${original.project.id}.future.json`,
  ]);
  assert.deepEqual(await drafts.list(independent.project.id), {
    drafts: [history.independentRecord],
    issues: [],
  });
  await assert.rejects(access(history.file), { code: 'ENOENT' });
  for (const item of history.retained)
    assert.equal(
      await fileHash(item.file),
      item.sha256,
      `Retained file changed: ${basename(item.file)}`,
    );
  assert.equal(
    (await readFile(join(app, 'staging', `${expected.queued.id}.ready`)))
      .length,
    expected.queued.size,
  );
  await assertOriginalFiles(expected);
  await assert.rejects(access(defaultRoot), { code: 'ENOENT' });
}
