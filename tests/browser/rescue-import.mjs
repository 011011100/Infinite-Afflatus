// Real production main/preload/renderer with isolated native dialog selections.
// Run after the coordinated production build: node tests/browser/rescue-import.mjs
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  new URL('./rescue-import-bootstrap.cjs', import.meta.url),
);
await withFixture('afflatus-rescue-import-', async (base, log) => {
  await mkdir(join(base, 'profile'));
  await mkdir(join(base, 'projects'));
  await mkdir(join(base, 'external'));
  for (const [name, content] of [
    ['第一份.txt', '原始文本1，不允许救援修改源文件。'],
    ['second.txt', 'Original source 2 — preserve bytes.'],
  ])
    await writeFile(join(base, name), content, { flag: 'wx' });
  const sources = await Promise.all(
    ['第一份.txt', 'second.txt'].map(async (name) => ({
      file: join(base, name),
      sha256: await hash(join(base, name)),
    })),
  );
  await runElectron(electron, bootstrap, base, ['--mode=configure'], log);
  const seed = JSON.parse(await readFile(join(base, 'seed.json'), 'utf8'));
  const protectedFiles = [
    ...sources,
    { file: seed.exportPath, sha256: await hash(seed.exportPath) },
    { file: seed.independentFile, sha256: await hash(seed.independentFile) },
    {
      file: seed.independentDraftFile,
      sha256: await hash(seed.independentDraftFile),
    },
    ...seed.assets.map((asset) => ({
      file: join(base, 'projects', seed.project.folder, asset.relativePath),
      sha256: asset.sha256,
    })),
  ];
  for (const mode of ['import', 'restore', 'reopen-1', 'reopen-2']) {
    await runElectron(electron, bootstrap, base, [`--mode=${mode}`], log);
    for (const entry of protectedFiles)
      assert.equal(
        await hash(entry.file),
        entry.sha256,
        `${mode} changed protected file ${entry.file}`,
      );
  }
  console.log(
    'PASS rescue import: real native export, cancelled preview, separate draft-only import, explicit workspace restoration, two independent restarts; sources, registered media, external file and unrelated project/draft bytes preserved',
  );
});
