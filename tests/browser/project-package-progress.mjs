// Real built production main/preload/UI; no FFmpeg, decoder or progress mocks.
// Run after the coordinated build: node tests/browser/project-package-progress.mjs
import assert from 'node:assert/strict';
import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
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
  new URL('./project-package-progress-bootstrap.cjs', import.meta.url),
);

// 32 MiB of valid PCM silence, mono 48 kHz / 16 bit, with a correct RIFF header.
async function writeWave(file) {
  const bytes = 32 * 1024 ** 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(bytes + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(96000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  const handle = await open(file, 'wx');
  try {
    await handle.writeFile(header);
    const silence = Buffer.alloc(1024 ** 2);
    for (let offset = 0; offset < bytes; offset += silence.length)
      await handle.writeFile(silence);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

await withFixture('afflatus-project-package-progress-', async (base, log) => {
  for (const name of ['profile', 'projects', 'external'])
    await mkdir(join(base, name));
  await writeWave(join(base, '合法 静音.wav'));
  await writeFile(
    join(base, '原文.txt'),
    '源文件不可改写。\n项目包中的独立参考文字。',
    { flag: 'wx' },
  );
  await writeFile(
    join(base, 'external', '用户已有文件.txt'),
    'Existing unrelated destination bytes.',
    { flag: 'wx' },
  );
  const protectedFiles = await Promise.all(
    ['合法 静音.wav', '原文.txt', 'external/用户已有文件.txt'].map(
      async (name) => ({
        file: join(base, name),
        sha256: await hash(join(base, name)),
      }),
    ),
  );
  await runElectron(electron, bootstrap, base, ['--mode=configure'], log);
  const seed = JSON.parse(await readFile(join(base, 'seed.json'), 'utf8'));
  const originalDatabase = join(
    base,
    'projects',
    seed.project.folder,
    'project.sqlite',
  );
  const originalHash = await hash(originalDatabase);
  protectedFiles.push({
    file: join(
      base,
      'projects',
      seed.independent.project.folder,
      'project.sqlite',
    ),
    sha256: await hash(
      join(base, 'projects', seed.independent.project.folder, 'project.sqlite'),
    ),
  });
  for (const asset of seed.snapshot.assets)
    protectedFiles.push({
      file: join(base, 'projects', seed.project.folder, asset.relativePath),
      sha256: asset.sha256,
    });
  for (const mode of [
    'roundtrip',
    'cancel',
    'leave-home',
    'leave-close',
    'reopen-1',
    'reopen-2',
  ]) {
    await runElectron(electron, bootstrap, base, [`--mode=${mode}`], log);
    for (const entry of protectedFiles)
      assert.equal(
        await hash(entry.file),
        entry.sha256,
        `${mode} modified ${entry.file}`,
      );
    if (mode === 'roundtrip' || mode === 'cancel')
      assert.equal(
        await hash(originalDatabase),
        originalHash,
        `${mode} modified source database`,
      );
    if (mode === 'roundtrip') {
      const copies = JSON.parse(
        await readFile(join(base, 'copies.json'), 'utf8'),
      );
      protectedFiles.push({
        file: join(base, 'external', '完整 项目包.afflatus'),
        sha256: await hash(join(base, 'external', '完整 项目包.afflatus')),
      });
      for (const copy of copies) {
        const folder = join(base, 'projects', copy.project.folder);
        protectedFiles.push({
          file: join(folder, 'project.sqlite'),
          sha256: await hash(join(folder, 'project.sqlite')),
        });
        for (const asset of copy.assets)
          protectedFiles.push({
            file: join(folder, asset.relativePath),
            sha256: asset.sha256,
          });
      }
    }
    for (const directory of ['profile', 'projects', 'external'])
      assert.deepEqual(
        (await readdir(join(base, directory))).filter(
          (name) =>
            name.startsWith('.afflatus-package-') || name.endsWith('.part'),
        ),
        [],
        `${mode} left package temporary files`,
      );
  }
  console.log(
    'PASS project package progress: seven real production processes; export/import/duplicate, positive-byte cancellation, late chooser cancellation, dirty return/native-close ordering, two independent reopens; original media, archive and unrelated/copy databases unchanged',
  );
});
