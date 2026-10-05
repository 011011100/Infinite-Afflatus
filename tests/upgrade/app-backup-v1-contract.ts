import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Library } from '../../src/main/storage/library';
import type {
  AppBackupInfo,
  AppBackupRecoveryReport,
} from '../../src/shared/app-backup';
import type { GenerationWorkspace } from '../../src/shared/generation/workspace';
import type { InteractionSettings } from '../../src/shared/interaction/settings';
import type { ProjectSnapshot, SaveJob } from '../../src/shared/models';
import { fileHash } from './history';
import { withMovementDefaults } from './interaction-settings-expectations';

export interface AppBackupV1State {
  writerCommit: string;
  formatVersion: 1;
  mode: 'checkpoint' | 'interrupted-publication';
  app: string;
  root: string;
  backup: AppBackupInfo;
  projects: ProjectSnapshot[];
  jobs: SaveJob[];
  settings: InteractionSettings;
  workspace: GenerationWorkspace;
  protectedFiles: { file: string; size: number; sha256: string }[];
  uniqueReady: string;
  missingMedia: string;
  original: { name: string; size: number; sha256: string }[];
  intent?: { file: string; sha256: string; retainedDirectory: string };
}

export interface RestoredAppBackupV1 {
  state: AppBackupV1State;
  report: AppBackupRecoveryReport;
  retained: { file: string; sha256: string }[];
}

export async function assertBackupV1Files(state: AppBackupV1State) {
  for (const entry of state.protectedFiles) {
    assert.equal(await fileHash(entry.file), entry.sha256, entry.file);
    assert.equal((await readFile(entry.file)).length, entry.size, entry.file);
  }
  await assert.rejects(readFile(state.missingMedia), { code: 'ENOENT' });
}

export async function assertBackupV1Reopen(contract: RestoredAppBackupV1) {
  const { state, report } = contract;
  const library = await Library.open(state.app, state.root);
  try {
    await library.saves.idle();
    assert.equal(library.store.root, state.root);
    assert.deepEqual(
      library.store.jobs(),
      [],
      'Historical acknowledgements and ready jobs must not run after recovery',
    );
    assert.deepEqual(
      library.interactions.get(),
      withMovementDefaults(state.settings),
    );
    for (const project of state.projects)
      assert.deepEqual(
        await library.projects.open(project.project.id),
        project,
      );
    const primary = state.projects[0];
    assert.ok(primary);
    assert.deepEqual(
      await library.generation.readWorkspace(primary.project.id),
      state.workspace,
    );
    assert.equal(
      (await library.drafts.list(primary.project.id)).drafts.length,
      1,
    );
    assert.equal(
      (await library.editDrafts.list(primary.project.id)).drafts.length,
      1,
    );
    assert.deepEqual((await library.backups.list()).recovery, report);
    assert.equal(library.store.get('migration'), null);
    assert.equal(library.store.get('oldBackupOpaqueSetting'), null);
  } finally {
    await library.close();
  }
  await assertBackupV1Files(state);
  for (const file of contract.retained)
    assert.equal(await fileHash(file.file), file.sha256, file.file);
  for (const original of state.original) {
    const file = join(report.retainedDirectory, original.name);
    assert.equal(await fileHash(file), original.sha256);
    assert.equal((await readFile(file)).length, original.size);
  }
  await assert.rejects(readFile(join(state.app, 'app-backup-restore.json')), {
    code: 'ENOENT',
  });
}
