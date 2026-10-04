import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RootRelocationService } from '../../src/main/relocation/root-relocation-service';
import { Library } from '../../src/main/storage/library';
import { fileHash, runNode } from './history';
import {
  assertRelocatedLibrary,
  assertRelocationFiles,
  type RelocatedHistory,
  type RootRelocationHistory,
  rawAppRows,
} from './root-relocation-contract';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const baseline: { name: string; commit: string } = JSON.parse(
  await readFile(
    new URL('./root-relocation-baseline.json', import.meta.url),
    'utf8',
  ),
);
assert.equal(baseline.commit, '0550d2cbe736daf7443e8570a18c57a6aec1b4bd');

for (const damaged of [false, true]) {
  test(`${baseline.name}/${damaged ? 'damaged-old-draft' : 'ordinary'}: same original directory -> routing only -> real queue startup -> two independent restarts`, async (t) => {
    const base = await realpath(
      await mkdtemp(join(tmpdir(), 'afflatus-relocation-upgrade-')),
    );
    t.after(() =>
      rm(base, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 250,
      }),
    );
    const source = join(base, 'old-code');
    const data = join(base, 'data');
    await mkdir(source);
    await mkdir(data);
    try {
      await exec(
        'git',
        [
          'archive',
          '--format=tar',
          `--output=${join(base, 'history.tar')}`,
          baseline.commit,
          'package.json',
          'src/main',
          'src/shared',
        ],
        { cwd: repository },
      );
    } catch (error) {
      throw new Error(
        `Fixed historical writer ${baseline.commit} is required; fetch full history. Never substitute current code.`,
        { cause: error },
      );
    }
    await exec('tar', ['-xf', '../history.tar'], { cwd: source });
    const seeded = await runNode(
      new URL('./seed-root-relocation.mjs', import.meta.url),
      [source, data, baseline.commit],
    );
    assert.match(seeded.stdout, /PASS archived Library/);
    const state: RootRelocationHistory = JSON.parse(
      await readFile(join(data, 'root-relocation-history.json'), 'utf8'),
    );
    assert.equal(state.writerCommit, baseline.commit);
    assert.equal(state.saved.status, 'saved');
    assert.equal(state.queued.status, 'ready');
    const primary = state.projects[0];
    assert.ok(primary);
    const damagedDraft = damaged
      ? `${primary.project.id}.${state.draft.sessionId}.json`
      : null;
    if (damagedDraft) {
      // Corrupt the actual historical writer's file after it closed. This is
      // external damage, not a claim that the old service emits malformed JSON.
      const path = join('workspace-drafts', damagedDraft);
      const file = join(state.app, path);
      const original = await readFile(file);
      await writeFile(
        file,
        original.subarray(0, Math.floor(original.length / 2)),
      );
      const damagedFile = {
        path,
        size: (await lstat(file)).size,
        sha256: await fileHash(file),
      };
      assert.equal(
        state.appFiles.filter((item) => item.path === path).length,
        1,
      );
      state.appFiles = state.appFiles.map((item) =>
        item.path === path ? damagedFile : item,
      );
    }
    await unlink(join(state.root, state.savedMediaRelative));
    const appFile = join(state.app, 'app.sqlite');
    const originalDatabaseHash = await fileHash(appFile);
    const rows = rawAppRows(appFile);
    const anchorBytes = await readFile(
      join(state.app, 'app-backup-anchor.json'),
    );
    const newRoot = join(data, '找回 原目录 with spaces');
    const before = await lstat(state.root, { bigint: true });
    await rename(state.root, newRoot);
    const after = await lstat(newRoot, { bigint: true });
    for (const field of ['dev', 'ino', 'birthtimeNs'] as const)
      assert.equal(
        after[field],
        before[field],
        'Fixture must relocate the original directory, not copy it',
      );
    await assert.rejects(
      Library.open(state.app, join(data, 'unused-default-root')),
    );
    assert.equal(await fileHash(appFile), originalDatabaseHash);
    assert.deepEqual(
      await readFile(join(state.app, 'app-backup-anchor.json')),
      anchorBytes,
    );
    const service = new RootRelocationService(state.app);
    let contract: RelocatedHistory;
    try {
      assert.equal(await service.available(), true);
      const preview = await service.preview(newRoot);
      assert.equal(preview.oldRoot, state.root);
      assert.equal(preview.newRoot, newRoot);
      assert.equal(preview.pendingSaveCount, 1);
      assert.deepEqual(
        preview.projects
          .map(({ id, name }) => ({ id, name }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        state.projects
          .map(({ project }) => ({ id: project.id, name: project.name }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
      assert.deepEqual(
        rawAppRows(appFile),
        rows,
        'Preview cannot publish routing or replay work',
      );
      assert.equal(await fileHash(appFile), originalDatabaseHash);
      const result = await service.confirm(preview.token);
      assert.equal(result.root, newRoot);
      const next = rawAppRows(appFile);
      assert.deepEqual(next.projects, rows.projects);
      assert.deepEqual(
        next.saves,
        rows.saves,
        'Relocation does not execute or discard pending work',
      );
      const unchanged = (values: typeof rows.settings) =>
        values.filter(
          ({ key }) => key !== 'root' && key !== 'appBackupGeneration',
        );
      assert.deepEqual(
        unchanged(next.settings),
        unchanged(rows.settings),
        'Every other raw settings value and rowid is retained',
      );
      const newAnchor = JSON.parse(
        await readFile(join(state.app, 'app-backup-anchor.json'), 'utf8'),
      );
      assert.notEqual(newAnchor.generation, state.anchor.generation);
      assert.deepEqual(newAnchor, {
        ...state.anchor,
        generation: newAnchor.generation,
        root: { ...state.anchor.root, path: newRoot },
      });
      assert.equal(
        next.settings.find(({ key }) => key === 'root')?.value,
        newRoot,
      );
      assert.deepEqual(
        JSON.parse(
          String(
            next.settings.find(({ key }) => key === 'appBackupGeneration')
              ?.value,
          ),
        ),
        { profileId: state.anchor.profileId, generation: newAnchor.generation },
      );
      contract = {
        state,
        data,
        newRoot,
        damagedDraft,
        generation: newAnchor.generation,
        retainedDirectory: result.retainedDirectory,
        originalDatabaseHash,
      };
      await assertRelocationFiles(contract);
      assert.deepEqual(
        rawAppRows(join(result.retainedDirectory, 'app.sqlite')),
        rows,
      );
    } finally {
      await service.close();
    }
    // Publishing only changes routing. Only an ordinary Library startup may
    // drain the already-authorized ready result and register its exact asset.
    const library = await Library.open(
      state.app,
      join(data, 'unused-default-root'),
    );
    try {
      await library.saves.idle();
      await assertRelocatedLibrary(library, contract);
    } finally {
      await library.close();
    }
    const pending = state.projects[2];
    assert.ok(pending);
    contract.publishedPendingDatabaseHash = await fileHash(
      join(newRoot, pending.project.folder, 'project.sqlite'),
    );
    const file = join(data, 'relocated-current.json');
    await writeFile(file, JSON.stringify(contract));
    for (let restart = 0; restart < 2; restart++) {
      const result = await runNode(
        new URL('./reopen-root-relocation.ts', import.meta.url),
        [file],
      );
      assert.match(result.stdout, /PASS ordinary relocated-root restart/);
    }
    await assert.rejects(lstat(state.root), { code: 'ENOENT' });
    await assert.rejects(lstat(join(data, 'unused-default-root')), {
      code: 'ENOENT',
    });
    t.diagnostic(
      `Archived public writer ${baseline.commit}; no historical baseline changed; relocation publishing preserved every non-routing raw row and all project/staging/draft bytes before ordinary queue startup; ${process.platform}`,
    );
  });
}
