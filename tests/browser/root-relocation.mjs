// Seven isolated production Electron processes; no user's app or media is touched.
// Run after pnpm build: node tests/browser/root-relocation.mjs
import assert from 'node:assert/strict';
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
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
  new URL('./root-relocation-bootstrap.cjs', import.meta.url),
);
async function inventory(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false);
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [name, sha] of Object.entries(await inventory(path)))
        result[join(entry.name, name)] = sha;
    } else {
      assert.ok(entry.isFile());
      result[entry.name] = await hash(path);
    }
  }
  return result;
}
async function managedProfile(profile) {
  const result = {};
  for (const name of ['app.sqlite', 'app-backup-anchor.json'])
    result[name] = await hash(join(profile, name));
  for (const name of ['staging', 'workspace-drafts', 'project-edit-drafts'])
    result[name] = await inventory(join(profile, name));
  return result;
}
await withFixture('afflatus-root-relocation-', async (base, log) => {
  const profile = join(base, 'profile');
  await mkdir(profile);
  const root = join(base, 'projects');
  await mkdir(root);
  for (const [name, text] of [
    ['unique.txt', '移动后仍保留完整收到的唯一参考结果'],
    ['preserved.txt', '始终存在的原素材'],
  ])
    await writeFile(join(base, name), text, { flag: 'wx' });
  const run = (mode) =>
    runElectron(electron, bootstrap, base, [`--mode=${mode}`], log);
  await run('configure');
  const seed = JSON.parse(await readFile(join(base, 'seed.json'), 'utf8'));
  await rename(
    join(root, seed.project.folder, seed.assets[0].relativePath),
    join(base, 'held-original.txt'),
  );
  const moved = join(base, 'moved 项目 中文');
  await rename(root, moved);
  const copied = join(base, 'copied-projects');
  await cp(moved, copied, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const directories = [
    'moved 项目 中文',
    'copied-projects',
    'profile/workspace-drafts',
    'profile/project-edit-drafts',
  ];
  const before = Object.fromEntries(
    await Promise.all(
      directories.map(async (name) => [
        name,
        await inventory(join(base, name)),
      ]),
    ),
  );
  const profileBefore = await managedProfile(profile);
  const sourceBefore = await Promise.all(
    ['unique.txt', 'preserved.txt', 'held-original.txt'].map((name) =>
      hash(join(base, name)),
    ),
  );
  for (const mode of ['cancel', 'wrong-copy', 'quit-picker']) {
    await run(mode);
    assert.deepEqual(
      await managedProfile(profile),
      profileBefore,
      `${mode}: startup rejection/cancellation must not write profile files`,
    );
    for (const name of directories)
      assert.deepEqual(await inventory(join(base, name)), before[name]);
    await assert.rejects(readFile(join(profile, 'app-root-relocation.json')), {
      code: 'ENOENT',
    });
    await assert.rejects(
      readdir(join(profile, 'app-root-relocation-retained')),
      { code: 'ENOENT' },
    );
    for (const suffix of ['-wal', '-shm', '-journal'])
      await assert.rejects(readFile(join(profile, `app.sqlite${suffix}`)), {
        code: 'ENOENT',
      });
    await assert.rejects(readdir(root), { code: 'ENOENT' });
    console.log(
      `PASS ${mode}: no project window or database/anchor/media/draft/staging change; old path not recreated`,
    );
  }
  let retained;
  for (const mode of ['confirm', 'reopen-1', 'reopen-2']) {
    await run(mode);
    const report = JSON.parse(
      await readFile(join(base, `${mode}.json`), 'utf8'),
    );
    assert.equal(report.root, moved);
    const retainedRoot = join(profile, 'app-root-relocation-retained');
    const entries = await readdir(retainedRoot);
    assert.equal(entries.length, 1);
    const current = await inventory(join(retainedRoot, entries[0]));
    assert.equal(current['app.sqlite'], profileBefore['app.sqlite']);
    if (retained) assert.deepEqual(current, retained);
    retained = current;
    for (const name of directories)
      assert.deepEqual(
        await inventory(join(base, name)),
        before[name],
        `${mode}: original project and draft bytes preserved`,
      );
    assert.deepEqual(
      await Promise.all(
        ['unique.txt', 'preserved.txt', 'held-original.txt'].map((name) =>
          hash(join(base, name)),
        ),
      ),
      sourceBefore,
    );
    const staging = await inventory(join(profile, 'staging'));
    assert.equal(
      staging[`${seed.assets[0].id}.ready`],
      seed.assets[0].sha256,
      'Missing target keeps its last complete result',
    );
    assert.equal(
      staging[`${seed.assets[1].id}.ready`],
      undefined,
      'Verified saved target can use existing normal startup cleanup',
    );
    await assert.rejects(readdir(root), { code: 'ENOENT' });
    console.log(
      `PASS ${mode}: original database retained byte-for-byte; source/media/drafts unchanged; saved task cleanup verifies current relocated destination`,
    );
  }
});
