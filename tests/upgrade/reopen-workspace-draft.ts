import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { Library } from '../../src/main/storage/library';
import type { GenerationWorkspace } from '../../src/shared/generation/workspace';
import type { WorkspaceDraftRecord } from '../../src/shared/workspace-draft';
import { assertQueue, withoutTimestamp } from './checks';
import { assertOriginalFiles, fileHash, type HistoricalData } from './history';
import { withMovementDefaults } from './interaction-settings-expectations';

export interface HistoricalWorkspaceDraft {
  writerCommit: string;
  formatVersion: number;
  mode: 'unsubmitted' | 'last-submitted';
  record: WorkspaceDraftRecord;
  diskWorkspace: GenerationWorkspace;
  file: string;
  fileSha256: string;
  unrelatedFile: string;
  unrelatedContent: string;
  independentFile: string;
  independentSha256: string;
}

export interface WorkspaceDraftContract {
  app: string;
  defaultRoot: string;
  expected: HistoricalData;
  draft: HistoricalWorkspaceDraft;
  wantedWorkspace: GenerationWorkspace;
}

const [file] = process.argv.slice(2);
assert.ok(file);
const contract: WorkspaceDraftContract = JSON.parse(
  await readFile(file, 'utf8'),
);
const { app, defaultRoot, expected, draft, wantedWorkspace } = contract;
const [original, independent] = expected.projects;
assert.ok(original && independent);
const library = await Library.open(app, defaultRoot);
try {
  await library.saves.idle();
  assert.equal(library.state().root, expected.root);
  assert.deepEqual(
    library
      .state()
      .projects.map((project) => project.id)
      .sort(),
    [
      original.project.id,
      independent.project.id,
      expected.pendingProject.id,
    ].sort(),
  );
  assert.deepEqual(
    withoutTimestamp(await library.projects.open(original.project.id)),
    withoutTimestamp(original),
  );
  assert.deepEqual(
    await library.projects.open(independent.project.id),
    independent,
  );
  assert.deepEqual(
    await library.generation.readWorkspace(original.project.id),
    wantedWorkspace,
  );
  assert.deepEqual(
    await library.generation.read(original.project.id),
    expected.draft,
  );
  assert.deepEqual(
    library.interactions.get(),
    withMovementDefaults(expected.settings),
  );
  assert.deepEqual(await library.drafts.list(original.project.id), {
    drafts: [],
    issues: [],
  });
  await assert.rejects(access(draft.file), { code: 'ENOENT' });
  assert.equal(
    await readFile(draft.unrelatedFile, 'utf8'),
    draft.unrelatedContent,
  );
  assert.equal(await fileHash(draft.independentFile), draft.independentSha256);
  await assertQueue(library, expected);
  await assertOriginalFiles(expected);
} finally {
  await library.close();
}
