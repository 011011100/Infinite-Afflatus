import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BackupAnchor } from '../../src/main/backups/backup-anchor';
import type { Library } from '../../src/main/storage/library';
import type { GenerationWorkspace } from '../../src/shared/generation/workspace';
import type { InteractionSettings } from '../../src/shared/interaction/settings';
import type { ProjectSnapshot, SaveJob } from '../../src/shared/models';
import type { ProjectEditDraftRecord } from '../../src/shared/project-edit-draft';
import type { WorkspaceDraftRecord } from '../../src/shared/workspace-draft';
import { fileHash } from './history';
import { withMovementDefaults } from './interaction-settings-expectations';

export interface HistoricalFile {
  path: string;
  size: number;
  sha256: string;
}
export interface RootRelocationHistory {
  writerCommit: string;
  app: string;
  root: string;
  projects: ProjectSnapshot[];
  jobs: SaveJob[];
  saved: SaveJob;
  queued: SaveJob;
  workspace: GenerationWorkspace;
  pendingWorkspace: GenerationWorkspace;
  settings: InteractionSettings;
  draft: WorkspaceDraftRecord;
  nameDraft: ProjectEditDraftRecord;
  anchor: BackupAnchor;
  savedMediaRelative: string;
  rootFiles: HistoricalFile[];
  appFiles: HistoricalFile[];
  sourceFiles: HistoricalFile[];
}
export interface RelocatedHistory {
  state: RootRelocationHistory;
  data: string;
  newRoot: string;
  damagedDraft: string | null;
  generation: string;
  retainedDirectory: string;
  originalDatabaseHash: string;
  publishedPendingDatabaseHash?: string;
}

/** Read exact persisted rows; do not let AppStore parse and re-serialize values. */
export function rawAppRows(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    const rows = (table: string) =>
      db
        .prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) => ({ ...row }));
    return {
      settings: rows('settings'),
      projects: rows('projects'),
      saves: rows('saves'),
    };
  } finally {
    db.close();
  }
}

export async function assertRelocationFiles(
  contract: RelocatedHistory,
  afterStartup = false,
) {
  const { state, data, newRoot } = contract;
  const pendingProject = state.projects[2];
  assert.ok(pendingProject);
  for (const file of state.rootFiles) {
    const path = join(newRoot, file.path);
    if (file.path === state.savedMediaRelative) {
      await assert.rejects(readFile(path), { code: 'ENOENT' });
      continue;
    }
    if (
      afterStartup &&
      file.path === join(pendingProject.project.folder, 'project.sqlite')
    ) {
      if (contract.publishedPendingDatabaseHash)
        assert.equal(
          await fileHash(path),
          contract.publishedPendingDatabaseHash,
          'Unchanged queue must not re-save on the next process',
        );
      continue;
    }
    assert.equal(await fileHash(path), file.sha256, path);
    assert.equal((await readFile(path)).length, file.size, path);
  }
  for (const file of state.appFiles) {
    const path = join(state.app, file.path);
    if (
      afterStartup &&
      file.path === join('staging', `${state.queued.id}.ready`)
    ) {
      await assert.rejects(readFile(path), { code: 'ENOENT' });
      continue;
    }
    assert.equal(await fileHash(path), file.sha256, path);
    assert.equal((await readFile(path)).length, file.size, path);
  }
  for (const file of state.sourceFiles) {
    assert.equal(await fileHash(join(data, file.path)), file.sha256, file.path);
    assert.equal((await readFile(join(data, file.path))).length, file.size);
  }
  await assert.rejects(readFile(join(state.root, '用户自己的说明.txt')), {
    code: 'ENOENT',
  });
  assert.equal(
    await fileHash(join(contract.retainedDirectory, 'app.sqlite')),
    contract.originalDatabaseHash,
    'Keep the exact pre-relocation application database',
  );
}

export async function assertRelocatedLibrary(
  library: Library,
  contract: RelocatedHistory,
) {
  const { state } = contract;
  const [primary, independent, pending] = state.projects;
  assert.ok(primary && independent && pending);
  assert.equal(library.store.root, contract.newRoot);
  assert.deepEqual(
    library.interactions.get(),
    withMovementDefaults(state.settings),
  );
  assert.deepEqual(library.store.get('relocationOpaqueSetting'), {
    value: '不能白名单重建 settings',
    count: 29,
  });
  assert.deepEqual(library.store.get('appBackupGeneration'), {
    profileId: state.anchor.profileId,
    generation: contract.generation,
  });
  assert.deepEqual(await library.projects.open(primary.project.id), primary);
  assert.deepEqual(
    await library.projects.open(independent.project.id),
    independent,
  );
  assert.deepEqual(
    await library.generation.readWorkspace(primary.project.id),
    state.workspace,
  );
  assert.deepEqual(
    await library.generation.readWorkspace(pending.project.id),
    state.pendingWorkspace,
  );
  const relativePath = `assets/text/${state.queued.id}.txt`;
  const savedQueued = {
    ...state.queued,
    status: 'saved',
    error: null,
    outputRelativePath: relativePath,
  };
  assert.deepEqual(
    library.store.jobs(),
    state.jobs.map((job) => (job.id === state.queued.id ? savedQueued : job)),
  );
  assert.deepEqual(
    library.store.job(state.saved.id),
    state.saved,
    'Missing target must not convert a saved receipt to ready or replay it',
  );
  const queuedSnapshot = await library.projects.open(pending.project.id);
  assert.ok(
    Date.parse(queuedSnapshot.project.updatedAt) >=
      Date.parse(pending.project.updatedAt),
  );
  assert.deepEqual(queuedSnapshot, {
    ...pending,
    project: {
      ...pending.project,
      updatedAt: queuedSnapshot.project.updatedAt,
    },
    assets: [
      ...pending.assets,
      {
        id: state.queued.id,
        name: state.queued.name,
        relativePath,
        size: state.queued.size,
        sha256: state.queued.sha256,
        kind: state.queued.kind,
        usage: state.queued.usage,
      },
    ],
  });
  assert.equal(
    await fileHash(
      join(contract.newRoot, pending.project.folder, relativePath),
    ),
    state.queued.sha256,
  );
  const drafts = await library.drafts.list(primary.project.id);
  assert.deepEqual(drafts.drafts, contract.damagedDraft ? [] : [state.draft]);
  assert.equal(drafts.issues.length, contract.damagedDraft ? 1 : 0);
  if (contract.damagedDraft)
    assert.equal(drafts.issues[0]?.file, contract.damagedDraft);
  assert.deepEqual(await library.editDrafts.list(primary.project.id), {
    drafts: [state.nameDraft],
    issues: [],
  });
  const health = await library.health.scan(primary.project.id, 'full');
  assert.equal(health.issues.length, 1);
  assert.equal(health.issues[0]?.assetId, state.saved.id);
  assert.equal(health.issues[0]?.problem, 'missing');
  await assertRelocationFiles(contract, true);
}
