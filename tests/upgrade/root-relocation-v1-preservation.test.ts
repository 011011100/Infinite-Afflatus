import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RootRelocationService } from '../../src/main/relocation/root-relocation-service';
import type { RelocationIntent } from '../../src/main/relocation/root-relocation-types';
import { Library } from '../../src/main/storage/library';
import { fileHash, runNode } from './history';
import {
  assertRelocatedLibrary,
  assertRelocationFiles,
  type RelocatedHistory,
  rawAppRows,
} from './root-relocation-contract';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const baseline: {
  name: string;
  commit: string;
  dataCommit: string;
  formatVersion: number;
} = JSON.parse(
  await readFile(
    new URL('./root-relocation-v1-baseline.json', import.meta.url),
    'utf8',
  ),
);
assert.equal(baseline.commit, '025586b295817ceeed8714b6c317678ed6a3b924');
assert.equal(baseline.dataCommit, '0550d2cbe736daf7443e8570a18c57a6aec1b4bd');
assert.equal(baseline.formatVersion, 1);
interface HistoricalIntent {
  writerCommit: string;
  dataCommit: string;
  mode: 'archived-original' | 'published-old-anchor';
  formatVersion: number;
  contract: RelocatedHistory;
  originalRows: ReturnType<typeof rawAppRows>;
  intent: RelocationIntent;
  intentFile: string;
  oldAnchorHash: string;
}

for (const mode of ['archived-original', 'published-old-anchor'] as const) {
  test(`${baseline.name}/${mode}: actual archived v1 intent -> current resume -> two independent normal restarts`, async (t) => {
    const base = await realpath(
      await mkdtemp(join(tmpdir(), 'afflatus-relocation-v1-history-')),
    );
    t.after(() =>
      rm(base, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 250,
      }),
    );
    const data = join(base, 'data');
    await mkdir(data);
    const sources: string[] = [];
    for (const [name, commit] of [
      ['old-code', baseline.commit],
      ['old-data-code', baseline.dataCommit],
    ] as const) {
      const source = join(base, name);
      await mkdir(source);
      try {
        await exec(
          'git',
          [
            'archive',
            '--format=tar',
            `--output=${join(base, `${name}.tar`)}`,
            commit,
            'package.json',
            'src/main',
            'src/shared',
          ],
          { cwd: repository },
        );
      } catch (error) {
        throw new Error(
          `Fixed historical writer ${commit} is required; fetch full history, never substitute current code.`,
          { cause: error },
        );
      }
      await exec('tar', ['-xf', `../${name}.tar`], { cwd: source });
      sources.push(source);
    }
    const [source, dataSource] = sources;
    assert.ok(source && dataSource);
    const writer = await runNode(
      new URL('./seed-root-relocation-v1.mjs', import.meta.url),
      [source, dataSource, data, baseline.commit, baseline.dataCommit, mode],
    );
    assert.match(writer.stdout, /PASS archived v1 RootRelocationService/);
    const history: HistoricalIntent = JSON.parse(
      await readFile(join(data, 'root-relocation-v1-history.json'), 'utf8'),
    );
    assert.equal(history.writerCommit, baseline.commit);
    assert.equal(history.dataCommit, baseline.dataCommit);
    assert.equal(history.mode, mode);
    assert.equal(history.formatVersion, 1);
    const { contract, intent, originalRows } = history;
    const { state } = contract;
    const appFile = join(state.app, 'app.sqlite');
    const candidate = join(contract.retainedDirectory, 'new-app.sqlite');
    assert.deepEqual(
      JSON.parse(await readFile(history.intentFile, 'utf8')),
      intent,
    );
    assert.equal(
      await fileHash(join(state.app, 'app-backup-anchor.json')),
      history.oldAnchorHash,
    );
    assert.equal(await fileHash(candidate), intent.candidate.sha256);
    assert.deepEqual(
      rawAppRows(join(contract.retainedDirectory, 'app.sqlite')),
      originalRows,
    );
    await assertRelocationFiles(contract);
    if (mode === 'archived-original')
      await assert.rejects(lstat(appFile), { code: 'ENOENT' });
    else assert.equal(await fileHash(appFile), intent.candidate.sha256);
    const service = new RootRelocationService(state.app);
    try {
      await service.resumePending();
      assert.equal(await fileHash(appFile), intent.candidate.sha256);
      assert.deepEqual(
        JSON.parse(
          await readFile(join(state.app, 'app-backup-anchor.json'), 'utf8'),
        ),
        intent.resultAnchor,
      );
      const rows = rawAppRows(appFile);
      assert.deepEqual(rows.projects, originalRows.projects);
      assert.deepEqual(
        rows.saves,
        originalRows.saves,
        'Resuming publication must not execute or discard the old queue',
      );
      assert.deepEqual(
        rows.settings,
        originalRows.settings.map((row) =>
          row.key === 'root'
            ? { ...row, value: contract.newRoot }
            : row.key === 'appBackupGeneration'
              ? {
                  ...row,
                  value: JSON.stringify({
                    profileId: state.anchor.profileId,
                    generation: contract.generation,
                  }),
                }
              : row,
        ),
      );
      await assertRelocationFiles(contract);
      await assert.rejects(lstat(history.intentFile), { code: 'ENOENT' });
      await assert.rejects(lstat(candidate), { code: 'ENOENT' });
      await service.resumePending();
      assert.equal(
        await fileHash(appFile),
        intent.candidate.sha256,
        'A settled intent must never replay',
      );
    } finally {
      await service.close();
    }
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
      join(contract.newRoot, pending.project.folder, 'project.sqlite'),
    );
    const reopening = join(data, 'relocation-v1-current.json');
    await writeFile(reopening, JSON.stringify(contract));
    for (let restart = 0; restart < 2; restart++) {
      const result = await runNode(
        new URL('./reopen-root-relocation.ts', import.meta.url),
        [reopening],
      );
      assert.match(result.stdout, /PASS ordinary relocated-root restart/);
    }
    await assert.rejects(lstat(state.root), { code: 'ENOENT' });
    await assert.rejects(lstat(join(data, 'unused-default-root')), {
      code: 'ENOENT',
    });
    t.diagnostic(
      `Immutable intent writer ${baseline.commit}; immutable data writer ${baseline.dataCommit}; ${mode}; raw order, original archive, both draft formats, missing-target ready and source hashes preserved; ${process.platform}`,
    );
  });
}
