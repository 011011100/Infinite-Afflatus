import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Library } from '../../src/main/storage/library';
import type { GenerationDraft } from '../../src/shared/generation/draft';
import type { GenerationWorkspace } from '../../src/shared/generation/workspace';
import type { InteractionSettings } from '../../src/shared/interaction/settings';
import type { ProjectSnapshot } from '../../src/shared/models';
import { assertQueue, withoutTimestamp } from './checks';
import { assertOriginalFiles, type HistoricalData } from './history';

const [app, defaultRoot, contractFile] = process.argv.slice(2);
assert.ok(app && defaultRoot && contractFile);
const {
  expected,
  wantedProject,
  wantedWorkspace,
  wantedDraft,
  wantedSettings,
}: {
  expected: HistoricalData;
  wantedProject: ProjectSnapshot;
  wantedWorkspace: GenerationWorkspace;
  wantedDraft: GenerationDraft;
  wantedSettings: InteractionSettings;
} = JSON.parse(await readFile(contractFile, 'utf8'));
const [original, independent] = expected.projects;
assert.ok(original && independent);
const library = await Library.open(app, defaultRoot);
try {
  await library.saves.idle();
  assert.equal(library.state().root, expected.root);
  assert.deepEqual(
    withoutTimestamp(await library.projects.open(original.project.id)),
    withoutTimestamp(wantedProject),
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
    wantedDraft,
  );
  assert.deepEqual(library.interactions.get(), wantedSettings);
  await assertQueue(library, expected);
  await assertOriginalFiles(expected);
} finally {
  await library.close();
}
