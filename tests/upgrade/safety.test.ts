import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readProject } from '../../src/main/projects/project-database';
import { Library } from '../../src/main/storage/library';
import { assertOriginalFiles, baselines, fileHash, history } from './history';

function change(file: string, sql: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

for (const baseline of baselines) {
  test(`${baseline.name}: regression assertions detect a deleted record and overwritten source file`, async (t) => {
    const f = await history(t, baseline);
    const original = f.expected.projects[0];
    assert.ok(original);
    change(
      f.projectFile,
      'DELETE FROM assets WHERE rowid = (SELECT max(rowid) FROM assets)',
    );
    assert.throws(
      () => assert.deepEqual(readProject(f.projectFile), original),
      assert.AssertionError,
    );
    const asset = original.assets.at(-1);
    assert.ok(asset);
    await writeFile(
      join(f.expected.root, original.project.folder, asset.relativePath),
      'deliberate data loss',
    );
    await assert.rejects(
      assertOriginalFiles(f.expected),
      assert.AssertionError,
    );
  });

  for (const scope of ['project', 'app'] as const) {
    test(`${baseline.name}: unsupported ${scope} version fails without resetting populated data`, async (t) => {
      const f = await history(t, baseline);
      const file =
        scope === 'project' ? f.projectFile : join(f.app, 'app.sqlite');
      change(file, 'PRAGMA user_version = 999');
      const before = await readFile(file);
      if (scope === 'project') {
        assert.throws(() => readProject(file), /版本/);
      } else {
        await assert.rejects(Library.open(f.app, f.defaultRoot), /版本/);
      }
      assert.deepEqual(
        await readFile(file),
        before,
        'Rejected database must remain byte-identical',
      );
      await assertOriginalFiles(f.expected);
      assert.equal(
        await fileHash(join(f.app, 'staging', `${f.expected.queued.id}.ready`)),
        f.expected.queued.sha256,
      );
    });
  }

  test(`${baseline.name}: unrecognized table layout fails without recreating an empty project`, async (t) => {
    const f = await history(t, baseline);
    change(f.projectFile, 'ALTER TABLE assets RENAME TO unrecognized_assets');
    const before = await readFile(f.projectFile);
    assert.throws(() => readProject(f.projectFile), /assets/);
    assert.deepEqual(await readFile(f.projectFile), before);
    await assertOriginalFiles(f.expected);
  });

  test(`${baseline.name}: interrupted current write rolls back deletions in the historical database`, async (t) => {
    const f = await history(t, baseline);
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          fileURLToPath(new URL('./interrupt-write.ts', import.meta.url)),
          f.projectFile,
        ],
        { timeout: 10_000 },
      ),
      (error: unknown) => (error as { code: number }).code === 73,
    );
    const library = await Library.open(f.app, f.defaultRoot);
    try {
      await library.saves.idle();
      for (const project of f.expected.projects)
        assert.deepEqual(
          await library.projects.open(project.project.id),
          project,
        );
      const original = f.expected.projects[0];
      assert.ok(original);
      assert.deepEqual(
        await library.generation.read(original.project.id),
        f.expected.draft,
      );
      await assertOriginalFiles(f.expected);
    } finally {
      await library.close();
    }
  });
}
