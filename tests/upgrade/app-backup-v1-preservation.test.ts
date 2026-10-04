import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  copyFile,
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
import { AppBackupRecovery } from '../../src/main/backups/app-backup-recovery';
import { AppStore } from '../../src/main/storage/app-store';
import { Library } from '../../src/main/storage/library';
import type { AppBackupRecoveryReport } from '../../src/shared/app-backup';
import {
  type AppBackupV1State,
  assertBackupV1Files,
  type RestoredAppBackupV1,
} from './app-backup-v1-contract';
import { fileHash, runNode } from './history';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
const baseline: { name: string; commit: string; formatVersion: number } =
  JSON.parse(
    await readFile(
      new URL('./app-backup-v1-baseline.json', import.meta.url),
      'utf8',
    ),
  );
assert.match(
  baseline.commit,
  /^[a-f0-9]{40}$/,
  'A fixed native writer commit is mandatory; never use current code or HEAD',
);
assert.equal(baseline.formatVersion, 1);

for (const mode of ['checkpoint', 'interrupted-publication'] as const) {
  test(`${baseline.name}/${mode}: archived public writer -> current recovery -> two isolated restarts without historical cleanup`, async (t) => {
    const base = await realpath(
      await mkdtemp(join(tmpdir(), 'afflatus-backup-v1-upgrade-')),
    );
    t.after(() => rm(base, { recursive: true, force: true }));
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
        `Fixed native writer ${baseline.commit} must be fetched (checkout fetch-depth: 0); never substitute current code.`,
        { cause: error },
      );
    }
    await exec('tar', ['-xf', '../history.tar'], { cwd: source });
    await runNode(new URL('./seed-app-backup-v1.mjs', import.meta.url), [
      source,
      data,
      baseline.commit,
      mode,
    ]);
    const state: AppBackupV1State = JSON.parse(
      await readFile(join(data, 'app-backup-v1-expected.json'), 'utf8'),
    );
    assert.equal(state.writerCommit, baseline.commit);
    assert.equal(state.formatVersion, 1);
    assert.equal(state.mode, mode);
    assert.equal(state.backup.saveCount, state.jobs.length);
    assert.ok(
      state.jobs.some(
        (job) =>
          job.status === 'saved' && job.resultKey === 'reference:unique-saved',
      ),
    );
    assert.ok(
      state.jobs.some(
        (job) =>
          job.status === 'ready' && job.resultKey === 'reference:pending-v1',
      ),
    );
    await assertBackupV1Files(state);
    const recovery = new AppBackupRecovery(state.app, 'current-upgrade-reader');
    if (mode === 'checkpoint') {
      const preview = await recovery.preview(state.backup.id);
      assert.equal(preview.projectCount, state.projects.length);
      assert.equal(preview.retainedJobCount, state.jobs.length);
      for (const original of state.original)
        assert.equal(
          await fileHash(join(state.app, original.name)),
          original.sha256,
          'Preview cannot edit the damaged originals',
        );
      await recovery.restore(preview.token);
    } else {
      assert.ok(state.intent);
      assert.equal(await fileHash(state.intent.file), state.intent.sha256);
      await recovery.resumePending();
    }
    const store = new AppStore(join(state.app, 'app.sqlite'), state.root, {
      mode: 'existing',
    });
    let report: AppBackupRecoveryReport | null;
    try {
      report = store.get<AppBackupRecoveryReport>('appBackupRecovery');
      assert.deepEqual(store.jobs(), []);
      assert.deepEqual(store.get('interactions'), state.settings);
    } finally {
      await store.close();
    }
    assert.ok(report);
    assert.equal(report.backupId, state.backup.id);
    assert.equal(report.retainedJobCount, state.jobs.length);
    if (state.intent)
      assert.equal(report.retainedDirectory, state.intent.retainedDirectory);
    const retainedState = join(report.retainedDirectory, 'retained-state.json');
    const archive = JSON.parse(await readFile(retainedState, 'utf8'));
    const byId = (a: { id: string }, b: { id: string }) =>
      a.id.localeCompare(b.id);
    assert.deepEqual(
      archive.snapshot.jobs.sort(byId),
      [...state.jobs].sort(byId),
    );
    assert.deepEqual(archive.snapshot.settings.oldBackupOpaqueSetting, {
      keep: '未知设置只保留归档',
      count: 11,
    });
    const contract: RestoredAppBackupV1 = {
      state,
      report,
      retained: await Promise.all(
        [
          retainedState,
          ...state.original.map((original) =>
            join(report.retainedDirectory, original.name),
          ),
        ].map(async (file) => ({ file, sha256: await fileHash(file) })),
      ),
    };
    const contractFile = join(data, 'current-restored-contract.json');
    await writeFile(contractFile, JSON.stringify(contract));
    for (let restart = 0; restart < 2; restart++)
      await runNode(new URL('./reopen-app-backup-v1.ts', import.meta.url), [
        contractFile,
      ]);
    // The historical checkpoint is valid SQLite at the exact same root. Its old
    // generation must not revive either saved cleanup or pending saves.
    const currentDatabase = join(state.app, 'app.sqlite');
    await copyFile(
      join(state.app, 'app-backups', state.backup.id, 'app.sqlite'),
      currentDatabase,
    );
    const oldBytes = await readFile(currentDatabase);
    await assert.rejects(
      Library.open(state.app, state.root),
      /代际|旧|恢复|标记/,
    );
    assert.deepEqual(await readFile(currentDatabase), oldBytes);
    await assertBackupV1Files(state);
    t.diagnostic(
      `Fixed native writer ${baseline.commit}; ${mode}; original database/sidecars, both draft formats, project canvas/workspace/assets and unique ready byte-identical; two new Library processes; old generation rejected before workers.`,
    );
  });
}
