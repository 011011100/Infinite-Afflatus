import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Library } from '../../src/main/storage/library';
import type { ProjectSnapshot } from '../../src/shared/models';
import { assertIntegrity, assertWorkspace, withoutTimestamp } from './checks';
import {
  assertOriginalFiles,
  type Baseline,
  fileHash,
  history,
  runNode,
} from './history';
import type { HistoricalPackage, PackageContract } from './reopen-package';

const baseline: Baseline & { formatVersion: number } = JSON.parse(
  await readFile(new URL('./package-baseline.json', import.meta.url), 'utf8'),
);
assert.equal(baseline.scenario, 'image-workspace');
assert.equal(baseline.formatVersion, 1);
assert.match(
  baseline.commit,
  /^[a-f0-9]{40}$/,
  'A fixed package exporter commit is required; never use HEAD or the working tree',
);

test(`${baseline.name}: historical package -> current import/edit -> two process restarts preserves content and source bytes`, async (t) => {
  const f = await history(t, baseline);
  await runNode(new URL('./seed-package.mjs', import.meta.url), [
    join(f.base, 'old-code'),
    f.data,
    baseline.commit,
  ]);
  const pack: HistoricalPackage = JSON.parse(
    await readFile(join(f.data, 'package-expected.json'), 'utf8'),
  );
  assert.equal(pack.writerCommit, baseline.commit);
  assert.equal(pack.formatVersion, baseline.formatVersion);
  assert.equal(await fileHash(pack.packageFile), pack.packageSha256);
  const original = f.expected.projects[0];
  assert.ok(original && f.expected.workspace);
  assert.deepEqual(
    [...new Set(original.assets.map((asset) => asset.kind))].sort(),
    ['audio', 'image', 'text', 'video'],
  );

  const app = join(f.base, 'current-app');
  const root = join(f.base, '当前版本 项目库');
  const defaultRoot = join(f.base, 'unused-default-after-restart');
  const library = await Library.open(app, root);
  const settings = library.interactions.get();
  let contract!: PackageContract;
  try {
    const independent = await library.projects.create(
      '当前库独立项目，不得覆盖',
    );
    const imported = await library.packages.import(pack.packageFile);
    assert.notEqual(imported.project.id, original.project.id);
    assert.notEqual(imported.project.id, independent.project.id);
    assert.equal(imported.project.folder, imported.project.id);
    assert.equal(imported.project.name, original.project.name);
    assert.deepEqual({ ...imported, project: original.project }, original);
    assert.deepEqual(
      library.interactions.get(),
      settings,
      'Project packages must not replace application preferences',
    );
    assert.deepEqual(
      await library.generation.read(imported.project.id),
      f.expected.draft,
    );
    const workspace = await library.generation.readWorkspace(
      imported.project.id,
    );
    assertWorkspace(f.expected, workspace);
    assert.equal(workspace.shots.length, 2);

    // Derive the expected edit from the historical contract, not from a current
    // save response that could already have dropped unrelated fields.
    const wantedWorkspace = structuredClone(f.expected.workspace);
    const text = wantedWorkspace.shots[0]?.nodes.find(
      (node) => node.id === 'text-two',
    );
    assert.ok(text?.type === 'text');
    text.text += '\n当前版本编辑历史项目包';
    const imageGroup = wantedWorkspace.shots[0]?.groups.find(
      (group) => group.id === 'image-text-group',
    );
    assert.ok(imageGroup?.kind === 'image');
    imageGroup.parameters.resolution = '4K';
    const savedWorkspace = await library.generation.saveWorkspace(
      imported.project.id,
      wantedWorkspace,
    );
    wantedWorkspace.revision += 1;
    assert.deepEqual(savedWorkspace, wantedWorkspace);

    const cards = structuredClone(original.canvas.cards);
    const card = cards[0];
    assert.ok(card);
    const assetId = card.assetIds[0];
    const trim = assetId && card.trims?.[assetId];
    assert.ok(assetId && trim);
    card.position.x += 45.5;
    card.trims = {
      ...card.trims,
      [assetId]: { start: trim.start + 0.125, end: trim.end - 0.25 },
    };
    await library.projects.patchCanvas(imported.project.id, {
      before: imported.canvas.cards,
      after: cards,
    });
    const name = `${original.project.name}（包升级编辑）`;
    await library.projects.update(imported.project.id, { name });
    const wantedProject: ProjectSnapshot = {
      ...imported,
      project: { ...imported.project, name },
      canvas: {
        ...original.canvas,
        revision: original.canvas.revision + 1,
        cards,
      },
    };
    assert.deepEqual(
      withoutTimestamp(await library.projects.open(imported.project.id)),
      withoutTimestamp(wantedProject),
    );
    assert.deepEqual(
      await library.projects.open(independent.project.id),
      independent,
    );
    for (const asset of wantedProject.assets) {
      const file = join(root, wantedProject.project.folder, asset.relativePath);
      assert.equal(await fileHash(file), asset.sha256);
      assert.equal((await readFile(file)).length, asset.size);
    }
    contract = {
      app,
      root,
      defaultRoot,
      expected: f.expected,
      pack,
      independent,
      wantedProject,
      wantedWorkspace,
      settings,
    };
  } finally {
    await library.close();
  }

  const contractFile = join(f.data, 'package-after-edit.json');
  await writeFile(contractFile, JSON.stringify(contract));
  for (let restart = 0; restart < 2; restart++)
    await runNode(new URL('./reopen-package.ts', import.meta.url), [
      contractFile,
    ]);
  await assertOriginalFiles(f.expected);
  for (const database of pack.sourceDatabases)
    assert.equal(await fileHash(database.file), database.sha256);
  assert.equal(
    await fileHash(pack.packageFile),
    pack.packageSha256,
    'Import and editing must leave the historical package unchanged',
  );
  await assert.rejects(access(defaultRoot), { code: 'ENOENT' });
  assertIntegrity(join(app, 'app.sqlite'));
  for (const project of [contract.independent, contract.wantedProject])
    assertIntegrity(join(root, project.project.folder, 'project.sqlite'));
  t.diagnostic(
    `Verified package format ${baseline.formatVersion} from fixed exporter ${baseline.commit}: 6 media files, clip order/trims, independent video/image groups, text overrides, labels, edited content, source database/media/package hashes and two independent restarts.`,
  );
});
