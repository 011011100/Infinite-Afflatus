import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Library } from '../../src/main/storage/library';
import type { GenerationWorkspace } from '../../src/shared/generation/workspace';
import type { InteractionSettings } from '../../src/shared/interaction/settings';
import type { ProjectSnapshot } from '../../src/shared/models';
import { withoutTimestamp } from './checks';
import { assertOriginalFiles, fileHash, type HistoricalData } from './history';

export interface HistoricalPackage {
  writerCommit: string;
  formatVersion: number;
  packageFile: string;
  packageSha256: string;
  sourceDatabases: { file: string; sha256: string }[];
}
export interface PackageContract {
  app: string;
  root: string;
  defaultRoot: string;
  expected: HistoricalData;
  pack: HistoricalPackage;
  independent: ProjectSnapshot;
  wantedProject: ProjectSnapshot;
  wantedWorkspace: GenerationWorkspace;
  settings: InteractionSettings;
}

const [file] = process.argv.slice(2);
assert.ok(file);
const contract: PackageContract = JSON.parse(await readFile(file, 'utf8'));
const {
  app,
  root,
  defaultRoot,
  expected,
  pack,
  independent,
  wantedProject,
  wantedWorkspace,
  settings,
} = contract;
const library = await Library.open(app, defaultRoot);
try {
  await library.saves.idle();
  assert.equal(library.state().root, root);
  assert.deepEqual(
    library
      .state()
      .projects.map((project) => project.id)
      .sort(),
    [independent.project.id, wantedProject.project.id].sort(),
  );
  assert.deepEqual(
    withoutTimestamp(await library.projects.open(wantedProject.project.id)),
    withoutTimestamp(wantedProject),
  );
  assert.deepEqual(
    await library.projects.open(independent.project.id),
    independent,
  );
  assert.deepEqual(
    await library.generation.readWorkspace(wantedProject.project.id),
    wantedWorkspace,
  );
  assert.deepEqual(
    await library.generation.read(wantedProject.project.id),
    expected.draft,
  );
  assert.deepEqual(library.interactions.get(), settings);
  for (const asset of wantedProject.assets) {
    const path = join(root, wantedProject.project.folder, asset.relativePath);
    assert.equal(await fileHash(path), asset.sha256);
    assert.equal((await readFile(path)).length, asset.size);
  }
  await assertOriginalFiles(expected);
  for (const database of pack.sourceDatabases)
    assert.equal(await fileHash(database.file), database.sha256);
  assert.equal(await fileHash(pack.packageFile), pack.packageSha256);
} finally {
  await library.close();
}
