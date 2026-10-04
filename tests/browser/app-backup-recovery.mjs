// Production main/preload/renderer and native startup recovery, in a disposable profile.
// Run after pnpm build: node tests/browser/app-backup-recovery.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  hash,
  withFixture,
  runElectron,
} = require('./reference-import-harness.cjs');
const executable = require('electron');
const bootstrap = fileURLToPath(
  new URL('./app-backup-recovery-bootstrap.cjs', import.meta.url),
);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function inventory(directory) {
  const result = {};
  for (const item of await readdir(directory, { withFileTypes: true })) {
    assert.equal(
      item.isSymbolicLink(),
      false,
      'Fixture inventory must not follow links',
    );
    const path = join(directory, item.name);
    if (item.isDirectory()) {
      for (const [name, sha] of Object.entries(await inventory(path)))
        result[join(item.name, name)] = sha;
    } else {
      assert.ok(item.isFile());
      result[item.name] = await hash(path);
    }
  }
  return result;
}

await withFixture('afflatus-app-backup-', async (base, log) => {
  const profile = join(base, 'profile');
  await mkdir(profile);
  await mkdir(join(base, 'projects'));
  for (const [name, text] of [
    ['unique.txt', '备份前完整收到的唯一参考结果'],
    ['preserved.txt', '始终留在项目中的素材'],
  ])
    await writeFile(join(base, name), text, { flag: 'wx' });
  const sourceBefore = await Promise.all(
    ['unique.txt', 'preserved.txt'].map((name) => hash(join(base, name))),
  );
  const screenshot = `${log}.png`;
  await writeFile(join(base, 'control.json'), JSON.stringify({ screenshot }));
  await runElectron(executable, bootstrap, base, ['--mode=configure'], log);
  const seed = JSON.parse(await readFile(join(base, 'seed.json'), 'utf8'));
  assert.equal(seed.backup.projectCount, 1);
  assert.equal(seed.backup.saveCount, 2);
  assert.equal((await stat(screenshot)).size > 0, true);

  // The first fully received result now exists only in staging. A restored saved
  // job must never replay the old startup cleanup and delete its last copy.
  await unlink(
    join(base, 'projects', seed.project.folder, seed.assets[0].relativePath),
  );
  const protectedDirectories = [
    'projects',
    'profile/staging',
    'profile/workspace-drafts',
    'profile/project-edit-drafts',
    'profile/app-backups',
  ];
  const before = Object.fromEntries(
    await Promise.all(
      protectedDirectories.map(async (name) => [
        name,
        await inventory(join(base, name)),
      ]),
    ),
  );
  const original = {};
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const name = `app.sqlite${suffix}`;
    const bytes = Buffer.from(
      `fixture corrupted ${name}: keep these original bytes`,
    );
    await writeFile(join(profile, name), bytes);
    original[name] = digest(bytes);
  }
  await writeFile(
    join(base, 'evidence.json'),
    JSON.stringify({ before, original }),
  );
  await runElectron(executable, bootstrap, base, ['--mode=cancel'], log);
  for (const [name, sha] of Object.entries(original))
    assert.equal(
      await hash(join(profile, name)),
      sha,
      'Cancelled preview must not change the original database or sidecars',
    );
  for (const name of protectedDirectories)
    assert.deepEqual(await inventory(join(base, name)), before[name]);
  console.log(
    'PASS cancel: real startup inspection and cancelled confirmation preserve corrupt database, all sidecars, project media, unique ready results, both draft formats and backup bytes',
  );

  let retained;
  for (const mode of ['restore', 'reopen-1', 'reopen-2']) {
    await runElectron(executable, bootstrap, base, [`--mode=${mode}`], log);
    const report = JSON.parse(
      await readFile(join(base, `${mode}.json`), 'utf8'),
    );
    assert.equal(
      dirname(report.retainedDirectory),
      join(profile, 'app-backup-retained'),
    );
    const actual = await inventory(report.retainedDirectory);
    for (const [name, sha] of Object.entries(original))
      assert.equal(
        actual[name],
        sha,
        'Restore retains every original database/sidecar byte',
      );
    if (retained)
      assert.deepEqual(
        actual,
        retained,
        'Fresh processes must not rewrite retained records',
      );
    retained = actual;
    for (const name of protectedDirectories)
      assert.deepEqual(
        await inventory(join(base, name)),
        before[name],
        `${mode}: protected files remain byte-identical`,
      );
    assert.deepEqual(
      await Promise.all(
        ['unique.txt', 'preserved.txt'].map((name) => hash(join(base, name))),
      ),
      sourceBefore,
    );
    console.log(
      `PASS ${mode}: restored settings/index usable; historical jobs are retained outside the live queue; original files, media, unique ready result and independent drafts stay byte-identical`,
    );
  }
  await runElectron(executable, bootstrap, base, ['--mode=repair'], log);
  const repairedPath = join(seed.project.folder, seed.assets[0].relativePath);
  for (const name of protectedDirectories) {
    const expected =
      name === 'projects'
        ? { ...before[name], [repairedPath]: seed.assets[0].sha256 }
        : before[name];
    assert.deepEqual(
      await inventory(join(base, name)),
      expected,
      'Explicit media repair only adds its exact missing file',
    );
  }
  assert.deepEqual(
    await Promise.all(
      ['unique.txt', 'preserved.txt'].map((name) => hash(join(base, name))),
    ),
    sourceBefore,
  );
  console.log(`Production settings backup screenshot: ${screenshot}`);
});
