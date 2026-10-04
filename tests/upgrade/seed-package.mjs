// Package writer contract: business code comes only from the pinned Git archive.
// seed-history.mjs creates the established image-workspace scenario beforehand.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, directory, writerCommit] = process.argv.slice(2);
assert.ok(source && directory);
assert.match(writerCommit, /^[a-f0-9]{40}$/);
const { Library } = await import(
  pathToFileURL(join(source, 'src/main/storage/library.ts')).href
);
const { readPackageHeader } = await import(
  pathToFileURL(join(source, 'src/main/packages/package-format.ts')).href
);
const expected = JSON.parse(
  await readFile(join(directory, 'expected.json'), 'utf8'),
);
assert.equal(expected.mode, 'image-workspace');
const original = expected.projects[0];
assert.ok(original && expected.workspace);
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const library = await Library.open(join(directory, 'app'), expected.root);
const packageFile = join(directory, '固定历史版本 中文备份.afflatus');
try {
  await library.saves.idle();
  assert.deepEqual(await library.projects.open(original.project.id), original);
  assert.deepEqual(
    await library.generation.readWorkspace(original.project.id),
    expected.workspace,
  );
  assert.deepEqual(
    await library.generation.read(original.project.id),
    expected.draft,
  );
  const sourceDatabases = await Promise.all(
    expected.projects.map(async (project) => {
      const file = join(
        expected.root,
        project.project.folder,
        'project.sqlite',
      );
      return { file, sha256: await hash(file) };
    }),
  );
  await library.packages.export(original.project.id, packageFile);
  const input = await open(packageFile, 'r');
  let manifest;
  try {
    ({ manifest } = await readPackageHeader(input));
  } finally {
    await input.close();
  }
  assert.equal(manifest.format, 'infinite-afflatus');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.entries.length, original.assets.length + 1);
  const sortByPath = (a, b) => a.path.localeCompare(b.path);
  assert.deepEqual(
    manifest.entries
      .filter((entry) => entry.path !== 'project.sqlite')
      .sort(sortByPath),
    original.assets
      .map((asset) => ({
        type: 'file',
        path: asset.relativePath,
        size: asset.size,
        sha256: asset.sha256,
      }))
      .sort(sortByPath),
  );
  for (const database of sourceDatabases)
    assert.equal(
      await hash(database.file),
      database.sha256,
      'Historical export must not modify source databases',
    );
  await writeFile(
    join(directory, 'package-expected.json'),
    JSON.stringify(
      {
        writerCommit,
        formatVersion: 1,
        packageFile,
        packageSha256: await hash(packageFile),
        sourceDatabases,
      },
      null,
      2,
    ),
  );
} finally {
  await library.close();
}
