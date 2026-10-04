// Ordinary production startup must retain the last complete copy after a prior
// durable save. Only native choices and the initial final-cleanup fault are controlled.
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  hash,
  withFixture,
  runElectron,
} = require('./reference-import-harness.cjs');
const electron = require('electron');
const bootstrap = fileURLToPath(
  new URL('./saved-staging-preservation-bootstrap.cjs', import.meta.url),
);
const exists = async (file) =>
  stat(file).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );

await withFixture('afflatus-saved-staging-', async (base, log) => {
  await mkdir(join(base, 'profile'));
  await mkdir(join(base, 'projects'));
  const sources = [
    'missing.txt',
    'changed.txt',
    'valid.txt',
    'independent.txt',
  ];
  for (const name of sources)
    await writeFile(
      join(base, name),
      `Original synthetic reference ${name} — 保留原文。`,
      { flag: 'wx' },
    );
  const sourceHashes = await Promise.all(
    sources.map((name) => hash(join(base, name))),
  );
  await runElectron(electron, bootstrap, base, ['--mode=configure'], log);
  const seed = JSON.parse(await readFile(join(base, 'seed.json'), 'utf8'));
  const targets = seed.assets.map((asset) =>
    join(base, 'projects', seed.project.folder, asset.relativePath),
  );
  const ready = seed.assets.map((asset) =>
    join(base, 'profile', 'staging', `${asset.id}.ready`),
  );
  for (let i = 0; i < 3; i++)
    assert.equal(await hash(ready[i]), seed.assets[i].sha256);
  await rename(targets[0], join(base, 'retained-missing.txt'));
  await rename(targets[1], join(base, 'retained-changed.txt'));
  await writeFile(targets[1], Buffer.alloc(seed.assets[1].size, 0x58), {
    flag: 'wx',
  });
  const changedHash = await hash(targets[1]);
  assert.notEqual(changedHash, seed.assets[1].sha256);
  const protectedFiles = [
    join(base, 'projects', seed.project.folder, 'project.sqlite'),
    join(base, 'projects', seed.independent.project.folder, 'project.sqlite'),
    join(
      base,
      'projects',
      seed.independent.project.folder,
      seed.independent.assets[0].relativePath,
    ),
    join(base, 'retained-missing.txt'),
    join(base, 'retained-changed.txt'),
  ];
  const protectedHashes = await Promise.all(protectedFiles.map(hash));
  for (const mode of ['reopen-1', 'reopen-2', 'repair', 'reopen-repaired']) {
    await runElectron(electron, bootstrap, base, [`--mode=${mode}`], log);
    assert.deepEqual(
      await Promise.all(protectedFiles.map(hash)),
      protectedHashes,
    );
    assert.deepEqual(
      await Promise.all(sources.map((name) => hash(join(base, name)))),
      sourceHashes,
    );
    assert.equal(
      await hash(targets[1]),
      changedHash,
      'Wrong existing content is never overwritten',
    );
    assert.equal(
      await hash(ready[1]),
      seed.assets[1].sha256,
      'Wrong target cannot authorize cleanup',
    );
    assert.equal(await hash(targets[2]), seed.assets[2].sha256);
    assert.equal(
      await exists(ready[2]),
      false,
      'Verified valid target permits cleanup',
    );
    if (mode.startsWith('reopen-') && mode !== 'reopen-repaired') {
      assert.equal(
        await exists(targets[0]),
        false,
        'Saved job must not be replayed',
      );
      assert.equal(await hash(ready[0]), seed.assets[0].sha256);
    } else {
      assert.equal(await hash(targets[0]), seed.assets[0].sha256);
      assert.equal(
        await exists(ready[0]),
        mode === 'repair',
        'Explicit repair precedes next-startup cleanup',
      );
    }
  }
  console.log(
    'PASS saved staging: ordinary production restarts preserve missing/changed targets and saved task records; explicit health repair restores the exact missing media, and only a later verified restart removes its cache; sources and unrelated project bytes remain unchanged',
  );
});
