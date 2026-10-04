import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { MigrationJournal } from '../../src/main/migration/manifest';
import type { ProjectSnapshot, SaveJob } from '../../src/shared/models';
import { fileHash, runNode } from './history';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
export const appBackupLegacyBaseline: { name: string; commit: string } =
  JSON.parse(
    await readFile(
      new URL('./app-backup-legacy-baseline.json', import.meta.url),
      'utf8',
    ),
  );
assert.match(appBackupLegacyBaseline.commit, /^[a-f0-9]{40}$/);

export interface LegacyAppBackupState {
  writerCommit: string;
  mode: 'saved-ready' | 'migration-verifying';
  app: string;
  root: string;
  target: string;
  project: ProjectSnapshot;
  independent: ProjectSnapshot;
  job: SaveJob;
  media: string;
  ready: string;
  bytes: number;
  sha256: string;
  retained: { file: string; sha256: string }[];
  journal?: MigrationJournal;
}

export async function assertLegacyBackupFiles(state: LegacyAppBackupState) {
  for (const file of state.retained)
    assert.equal(await fileHash(file.file), file.sha256, file.file);
  await assert.rejects(readFile(state.media), { code: 'ENOENT' });
}

export async function legacyAppBackupHistory(
  t: TestContext,
  mode: LegacyAppBackupState['mode'],
) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-app-backup-history-')),
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
        appBackupLegacyBaseline.commit,
        'package.json',
        'src/main',
        'src/shared',
      ],
      { cwd: repository },
    );
  } catch (error) {
    throw new Error(
      `Fixed historical writer ${appBackupLegacyBaseline.commit} must be available; fetch full Git history, never substitute current code.`,
      { cause: error },
    );
  }
  // A relative archive path also works with Git Bash tar on Windows.
  await exec('tar', ['-xf', '../history.tar'], { cwd: source });
  const writer = runNode(
    new URL('./seed-app-backup-legacy.mjs', import.meta.url),
    [source, data, appBackupLegacyBaseline.commit, mode],
  );
  if (mode === 'migration-verifying')
    await assert.rejects(writer, (error: unknown) => {
      assert.equal((error as { code?: number }).code, 73);
      return true;
    });
  else await writer;
  const state: LegacyAppBackupState = JSON.parse(
    await readFile(join(data, 'app-backup-legacy.json'), 'utf8'),
  );
  assert.equal(state.writerCommit, appBackupLegacyBaseline.commit);
  assert.equal(state.mode, mode);
  assert.equal(state.job.status, 'saved');
  assert.equal(state.job.sha256, state.sha256);
  await assertLegacyBackupFiles(state);
  t.diagnostic(`Fixed pre-backup public writer ${state.writerCommit}; ${mode}`);
  return { base, data, state };
}
