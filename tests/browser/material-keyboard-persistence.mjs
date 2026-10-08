// Real production main/preload/renderer and native keys; no keyboard/storage mocks.
// Run only after the coordinated build: node tests/browser/material-keyboard-persistence.mjs
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  hash,
  withFixture,
  runElectron,
} = require('./reference-import-harness.cjs');
const electron = require('electron');
const bootstrap = fileURLToPath(
  new URL('./material-keyboard-persistence-bootstrap.cjs', import.meta.url),
);

function row(file, table, key) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const value = db
      .prepare(`SELECT value FROM ${table} WHERE key = ?`)
      .get(key);
    assert.ok(value, `Missing ${table}/${key}`);
    return JSON.parse(value.value);
  } finally {
    db.close();
  }
}

await withFixture('afflatus-material-keyboard-', async (base, log) => {
  for (const name of ['profile', 'projects']) await mkdir(join(base, name));
  // Public synthetic 1 x 1 PNG, decoded by Chromium; no media service is replaced.
  await writeFile(
    join(base, '键盘 原图.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      'base64',
    ),
    { flag: 'wx' },
  );
  await writeFile(
    join(base, '键盘 原文.txt'),
    '原始参考文字，移动素材不改写源文件。',
    {
      flag: 'wx',
    },
  );
  const protectedFiles = await Promise.all(
    ['键盘 原图.png', '键盘 原文.txt'].map(async (name) => ({
      file: join(base, name),
      sha256: await hash(join(base, name)),
    })),
  );
  let previousRevision = null;
  for (const mode of [
    'configure',
    'restart-edit',
    'restart-failure',
    'final-reopen',
  ]) {
    await runElectron(electron, bootstrap, base, [`--mode=${mode}`], log);
    const seed = JSON.parse(await readFile(join(base, 'seed.json'), 'utf8'));
    const expected = JSON.parse(
      await readFile(join(base, 'expected.json'), 'utf8'),
    );
    const database = join(
      base,
      'projects',
      seed.project.folder,
      'project.sqlite',
    );
    const workspace = row(database, 'metadata', 'generation-workspace');
    assert.deepEqual(
      { ...workspace, revision: 0 },
      { ...expected.workspace, revision: 0 },
      `${mode}: an independent SQLite connection must see every intended coordinate and unchanged document field`,
    );
    assert.deepEqual(
      row(join(base, 'profile', 'app.sqlite'), 'settings', 'interactions'),
      expected.settings,
      `${mode}: shortcut preferences must be durable, not only renderer state`,
    );
    if (previousRevision !== null) {
      if (mode === 'final-reopen')
        assert.equal(workspace.revision, previousRevision);
      else assert.ok(workspace.revision > previousRevision);
    }
    previousRevision = workspace.revision;
    if (mode === 'configure') {
      const unrelated = join(
        base,
        'projects',
        seed.independent.project.folder,
        'project.sqlite',
      );
      protectedFiles.push({ file: unrelated, sha256: await hash(unrelated) });
      for (const asset of seed.snapshot.assets)
        protectedFiles.push({
          file: join(base, 'projects', seed.project.folder, asset.relativePath),
          sha256: asset.sha256,
        });
    }
    for (const entry of protectedFiles)
      assert.equal(
        await hash(entry.file),
        entry.sha256,
        `${mode} modified ${entry.file}`,
      );
  }
  console.log(
    'PASS material keyboard persistence: four production processes; default/custom steps and undo/redo, cleared arrows without transient drift, group-relative clamp and pinned label, SQLite-loss dirty-close refusal and enabled-button focus recovery, native text and backward selection across global retry, continued input across reopen, settings and source/unrelated database preservation',
  );
});
