import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { GenerationDraft } from '../../src/shared/generation/draft';
import type { GenerationWorkspace } from '../../src/shared/generation/workspace';
import type { InteractionSettings } from '../../src/shared/interaction/settings';
import type {
  ProjectSnapshot,
  ProjectSummary,
  SaveJob,
} from '../../src/shared/models';

const exec = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));
export interface Baseline {
  name: string;
  scenario: 'legacy-draft' | 'material-workspace';
  commit: string;
  description: string;
}
export const baselines: Baseline[] = JSON.parse(
  await readFile(new URL('./baselines.json', import.meta.url), 'utf8'),
);
assert.ok(baselines.length >= 2, 'Do not silently remove historical coverage');

export interface HistoricalData {
  mode: string;
  root: string;
  projects: ProjectSnapshot[];
  pendingProject: ProjectSummary;
  queued: SaveJob;
  jobs: SaveJob[];
  settings: InteractionSettings;
  draft: GenerationDraft;
  workspace: GenerationWorkspace | null;
}

export async function runNode(script: URL, args: string[]) {
  return exec(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), fileURLToPath(script), ...args],
    { cwd: repository, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
  );
}

export async function history(t: TestContext, baseline: Baseline) {
  assert.match(baseline.commit, /^[a-f0-9]{40}$/);
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-upgrade-')),
  );
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = join(base, 'old-code');
  const data = join(base, 'data');
  await mkdir(source);
  await mkdir(data);
  const archive = join(base, 'history.tar');
  try {
    await exec(
      'git',
      [
        'archive',
        '--format=tar',
        `--output=${archive}`,
        baseline.commit,
        'package.json',
        'src/main',
        'src/shared',
      ],
      { cwd: repository },
    );
  } catch (error) {
    throw new Error(
      `Historical baseline ${baseline.commit} is required. Fetch full Git history (checkout fetch-depth: 0); never fall back to current code.`,
      { cause: error },
    );
  }
  // Git Bash's tar treats a Windows drive colon as a remote host. Use relative argv.
  await exec('tar', ['-xf', '../history.tar'], { cwd: source });
  t.diagnostic(
    `${baseline.name}: historical writer ${baseline.commit}; Node ${process.version}; ${process.platform}`,
  );
  await runNode(new URL('./seed-history.mjs', import.meta.url), [
    source,
    data,
    baseline.scenario,
  ]);
  const expected: HistoricalData = JSON.parse(
    await readFile(join(data, 'expected.json'), 'utf8'),
  );
  assert.equal(expected.mode, baseline.scenario);
  assert.equal(expected.projects.length, 2);
  assert.equal(expected.projects[0]?.assets.length, 6);
  assert.equal(expected.projects[1]?.assets.length, 1);
  assert.equal(expected.queued.status, 'ready');
  const project = expected.projects[0];
  assert.ok(project);
  return {
    base,
    data,
    app: join(data, 'app'),
    expected,
    // A changed default must not detach the user's previously chosen library.
    defaultRoot: join(data, 'new-default-must-not-be-used'),
    projectFile: join(expected.root, project.project.folder, 'project.sqlite'),
  };
}

export async function fileHash(file: string) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

export async function assertOriginalFiles(expected: HistoricalData) {
  for (const project of expected.projects) {
    for (const asset of project.assets) {
      const file = join(
        expected.root,
        project.project.folder,
        asset.relativePath,
      );
      assert.equal(
        await fileHash(file),
        asset.sha256,
        `Source changed: ${asset.name}`,
      );
      assert.equal((await readFile(file)).length, asset.size);
    }
  }
  assert.equal(
    await readFile(join(expected.root, '用户自己放的文件', '说明.txt'), 'utf8'),
    '不能清理的用户文件',
  );
}
