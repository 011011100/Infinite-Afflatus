import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Library } from '../../src/main/storage/library';
import type { ProjectSnapshot, SaveJob } from '../../src/shared/models';
import type { ProjectEditDraftRecord } from '../../src/shared/project-edit-draft';
import { fileHash, runNode } from './history';

export interface SavedStagingHistory {
  writerCommit: string;
  app: string;
  root: string;
  original: string;
  media: string;
  ready: string;
  project: ProjectSnapshot;
  independent: ProjectSnapshot;
  job: SaveJob;
  jobs: SaveJob[];
  draft: ProjectEditDraftRecord;
  sha256: string;
  retained: { file: string; sha256: string }[];
}
export interface SavedStagingContract {
  state: SavedStagingHistory;
  mode: 'missing' | 'mismatch' | 'valid';
  wrongHash?: string;
}
const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
export async function savedStagingHistory(t: TestContext) {
  const baseline: { commit: string } = JSON.parse(
    await readFile(
      new URL('./saved-staging-baseline.json', import.meta.url),
      'utf8',
    ),
  );
  assert.equal(baseline.commit, 'dd0a849ac0407ea81fe9c38ebcf1982ce373128e');
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-saved-staging-history-')),
  );
  t.after(() =>
    rm(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }),
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
  await runNode(new URL('./seed-saved-staging.mjs', import.meta.url), [
    source,
    data,
    baseline.commit,
  ]);
  const state: SavedStagingHistory = JSON.parse(
    await readFile(join(data, 'saved-staging-history.json'), 'utf8'),
  );
  assert.equal(state.writerCommit, baseline.commit);
  assert.equal(state.job.status, 'saved');
  assert.equal(state.job.sha256, state.sha256);
  assert.equal(await fileHash(state.ready), state.sha256);
  assert.equal(await fileHash(state.media), state.sha256);
  t.diagnostic(
    `Real archived Library/SaveQueue writer ${baseline.commit}; post-save EACCES only; ${process.platform}`,
  );
  return { base, data, state };
}
export async function assertSavedStagingState(
  library: Library,
  contract: SavedStagingContract,
) {
  const { state, mode, wrongHash } = contract;
  assert.equal(library.store.root, state.root);
  assert.deepEqual(
    library.store.jobs(),
    state.jobs,
    'Do not rewrite saved receipts or replay already-committed jobs',
  );
  assert.deepEqual(
    await library.projects.open(state.project.project.id),
    state.project,
  );
  assert.deepEqual(
    await library.projects.open(state.independent.project.id),
    state.independent,
  );
  assert.deepEqual(await library.editDrafts.list(state.project.project.id), {
    drafts: [state.draft],
    issues: [],
  });
  assert.deepEqual(library.store.get('savedStagingHistoryPreference'), {
    value: '保留原设置 ✓',
    count: 13,
  });
  for (const item of state.retained)
    assert.equal(
      await fileHash(item.file),
      item.sha256,
      `Unrelated file changed: ${item.file}`,
    );
  if (mode === 'valid') {
    assert.equal(await fileHash(state.media), state.sha256);
    await assert.rejects(readFile(state.ready), { code: 'ENOENT' });
  } else {
    assert.equal(
      await fileHash(state.ready),
      state.sha256,
      'The complete staging result must remain available',
    );
    if (mode === 'missing')
      await assert.rejects(readFile(state.media), { code: 'ENOENT' });
    else
      assert.equal(
        await fileHash(state.media),
        wrongHash,
        'Do not overwrite an existing same-size but different target',
      );
  }
  const report = await library.health.scan(state.project.project.id, 'full');
  assert.equal(report.issues.length, mode === 'valid' ? 0 : 1);
  if (mode !== 'valid') assert.equal(report.issues[0]?.assetId, state.job.id);
}
