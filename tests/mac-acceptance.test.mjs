import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createMacAcceptancePlan,
  parseMacAcceptanceArguments,
  rendererScenarios,
  runAcceptanceStages,
} from '../scripts/mac-acceptance-plan.mjs';
import acceptanceSafety from '../scripts/mac-acceptance-safety.cjs';
import {
  acceptanceEnvironment,
  applyAcceptanceSafetyBoundaries,
  executeAcceptanceCommand,
  resolveNewPackagedExecutable,
} from '../scripts/run-mac-acceptance.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const plan = (args = [], env) =>
  createMacAcceptancePlan(parseMacAcceptanceArguments(args, env));
async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'afflatus-mac-runner-node-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('plan is runnable on any OS without a build, Electron import or output directory', () => {
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      ['scripts/run-mac-acceptance.mjs', '--plan'],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, AFFLATUS_MEDIA_TESTS: '0' },
      },
    ),
  );
  assert.equal(result.stages.filter((stage) => stage.id === 'build').length, 1);
  assert.equal(
    result.stages.find((stage) => stage.id === 'real-media-export')
      .skipReason !== null,
    true,
  );
  assert.equal(
    result.stages.find((stage) => stage.id === 'code-check').skipReason !==
      null,
    true,
  );
  assert.equal(result.outputDirectory, undefined);
  for (const id of [
    'B19-05',
    'B19-06',
    'chinese-ime',
    'staged-reference-desktop',
    'real-cloud',
    'media-redistribution',
  ])
    assert.ok(result.manual.some((item) => item.id === id));
});

test('real execution refuses non-macOS before launching anything', {
  skip: process.platform === 'darwin',
}, () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, ['scripts/run-mac-acceptance.mjs'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    (error) =>
      error.status === 2 &&
      /no build, Electron launch or package was attempted/.test(error.stderr),
  );
});

test('all isolated renderer scenarios and applicable desktop workflow scripts are registered individually', async () => {
  const fixtureSource = await readFile(
    join(root, 'tests/browser/run-fixtures.mjs'),
    'utf8',
  );
  const fixtureList = fixtureSource.match(/const available = \[([\s\S]*?)\];/);
  assert.ok(
    fixtureList,
    'Update this coverage test if the harness manifest moves',
  );
  const fixtures = [...fixtureList[1].matchAll(/'([^']+)'/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...rendererScenarios].sort(), fixtures.sort());
  const stages = plan().stages;
  for (const scenario of fixtures) {
    const stage = stages.find((item) => item.id === `renderer-${scenario}`);
    assert.deepEqual(stage.args.slice(-2), [
      'tests/browser/run-fixtures.mjs',
      scenario,
    ]);
  }
  const workflow = await readFile(
    join(root, '.github/workflows/desktop-package.yml'),
    'utf8',
  );
  const scripts = [
    ...workflow.matchAll(
      /run: node (?:--import tsx )?(tests\/browser\/[\w.-]+)/g,
    ),
  ]
    .map((match) => match[1])
    .filter((file) => !file.endsWith('/windows-installation.mjs'));
  for (const script of scripts)
    assert.ok(
      stages.some((stage) => stage.args.includes(script)),
      script,
    );
  assert.ok(
    stages.some((stage) =>
      stage.args.includes('tests/browser/preview-cache-desktop.cjs'),
    ),
  );
  assert.ok(
    stages.every(
      (stage) =>
        !stage.args.some((arg) =>
          /^(?:install|package:local|package:dir)$/.test(arg),
        ),
    ),
  );
  assert.equal(
    stages
      .find((stage) => stage.id === 'package-directory')
      .args.includes('<new-run-directory>/package'),
    true,
  );
  assert.equal(
    stages.find((stage) => stage.id === 'packaged-smoke').args.at(-1),
    '<exact-newly-built-app-executable>',
  );
});

test('opt-ins are explicit and unknown, duplicate or relative path flags fail closed', () => {
  const enabled = plan(['--include-code', '--real-delivery'], {
    AFFLATUS_MEDIA_TESTS: '1',
  });
  for (const id of [
    'code-check',
    'code-unit',
    'code-upgrade',
    'real-media-export',
    'real-media-delivery',
  ])
    assert.equal(
      enabled.stages.find((stage) => stage.id === id).skipReason,
      null,
    );
  assert.equal(plan(['--real-media']).options.realMedia, true);
  const bundle = join(tmpdir(), 'local-bundle');
  assert.equal(plan(['--media-tools', bundle]).options.bundleDirectory, bundle);
  for (const args of [
    ['--unknown'],
    ['--plan', '--plan'],
    ['--media-tools'],
    ['--media-tools', 'relative'],
  ])
    assert.throws(() => parseMacAcceptanceArguments(args));
});

test('failed independent checks continue, dependent checks block, and skipped checks cannot pass', async () => {
  const stages = [
    { id: 'build', dependsOn: [] },
    { id: 'renderer', dependsOn: [] },
    { id: 'package', dependsOn: ['build'] },
    { id: 'smoke', dependsOn: ['package'] },
    { id: 'optional', dependsOn: [], skipReason: 'Explicitly disabled.' },
  ];
  const executed = [];
  const snapshots = [];
  let time = 1000;
  const report = await runAcceptanceStages({
    plan: { stages },
    execute: async (stage) => {
      executed.push(stage.id);
      return {
        status: stage.id === 'build' ? 'failed' : 'passed',
        exitCode: stage.id === 'build' ? 1 : 0,
      };
    },
    persist: async (report) => {
      snapshots.push(structuredClone(report));
    },
    now: () => time++,
  });
  assert.deepEqual(executed, ['build', 'renderer']);
  assert.deepEqual(
    report.stages.map((stage) => stage.status),
    ['failed', 'passed', 'blocked', 'blocked', 'skipped'],
  );
  assert.equal(report.automatedStatus, 'failed');
  assert.equal(report.acceptanceStatus, 'requires-manual-validation');
  assert.equal(report.stages[2].durationMs, 0);
  assert.ok(report.stages[0].durationMs > 0);
  assert.equal(snapshots[0].stages[0].status, 'pending');
  assert.ok(
    snapshots.some((snapshot) => snapshot.stages[0].status === 'running'),
  );
});

test('interrupt preserves finished results and explicitly blocks every unexecuted stage', async () => {
  const controller = new AbortController();
  const report = await runAcceptanceStages({
    plan: {
      stages: [
        { id: 'first', dependsOn: [] },
        { id: 'next', dependsOn: [] },
      ],
    },
    execute: async () => {
      controller.abort();
      return { status: 'interrupted' };
    },
    persist: async () => {},
    signal: controller.signal,
  });
  assert.deepEqual(
    report.stages.map((stage) => stage.status),
    ['interrupted', 'blocked'],
  );
  assert.equal(report.status, 'interrupted');
  await assert.rejects(
    runAcceptanceStages({
      plan: { stages: [{ id: 'bad', dependsOn: ['missing'] }] },
      execute: async () => ({ status: 'passed' }),
      persist: async () => {},
    }),
    /Invalid or forward/,
  );
});

test('runner environment removes application paths, provider credentials and ambient real-media opt-ins', () => {
  const env = acceptanceEnvironment(
    {
      PATH: '/bin',
      AFFLATUS_USER_DATA: '/private-library',
      AFFLATUS_MEDIA_TESTS: '1',
      ARK_API_KEY: 'do-not-log',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_RENDERER_URL: 'http://user-app',
      CSC_LINK: 'private',
      FFMPEG_PATH: '/local/ffmpeg',
      NODE_OPTIONS: '--require /uncontrolled/preload.cjs',
      NODE_PATH: '/uncontrolled/modules',
    },
    '/owned/reports',
  );
  assert.equal(env.AFFLATUS_USER_DATA, undefined);
  assert.equal(env.ARK_API_KEY, undefined);
  assert.equal(env.CSC_LINK, undefined);
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.ELECTRON_RENDERER_URL, undefined);
  assert.equal(env.AFFLATUS_MEDIA_TESTS, '0');
  assert.equal(env.FFMPEG_PATH, '/local/ffmpeg');
  assert.equal(env.COREPACK_ENABLE_NETWORK, '0');
  assert.equal(env.npm_config_manage_package_manager_versions, 'false');
  assert.equal(env.npm_config_offline, 'true');
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NODE_PATH, undefined);
});

test('all automatic unpackaged Electron stages require the guard probe and packaged startup is blocked', () => {
  const result = applyAcceptanceSafetyBoundaries(
    plan(['--include-code', '--real-media', '--real-delivery']),
  );
  const probeIndex = result.stages.findIndex(
    (stage) => stage.id === 'preflight-safe-storage',
  );
  assert.ok(
    probeIndex >
      result.stages.findIndex((stage) => stage.id === 'preflight-electron'),
  );
  for (const stage of result.stages) {
    if (
      !/^(?:renderer-|desktop-|media-resources-|real-media-delivery$)/.test(
        stage.id,
      )
    )
      continue;
    assert.equal(stage.safeStorageGuard, true, stage.id);
    assert.ok(stage.dependsOn.includes('preflight-safe-storage'), stage.id);
    assert.ok(result.stages.indexOf(stage) > probeIndex);
  }
  assert.match(
    result.stages.find((stage) => stage.id === 'packaged-smoke')
      .safetyBlockReason,
    /Not run.*no verified pre-main/,
  );
  assert.ok(
    result.manual.some(
      (item) =>
        item.id === 'native-secure-storage' && item.status === 'not-run',
    ),
  );
});

test('all Node child-process launch APIs prepend the guard without changing fixture arguments or options', () => {
  const executable = '/owned/Electron.app/Contents/MacOS/Electron';
  const environment = {
    AFFLATUS_TEST_ELECTRON_EXECUTABLE: executable,
    AFFLATUS_TEST_SAFE_STORAGE_REPORTS: '/owned/reports',
    AFFLATUS_TEST_STAGE: 'fixture',
  };
  const calls = [];
  const childProcess = Object.fromEntries(
    ['spawn', 'spawnSync', 'execFile', 'execFileSync'].map((name) => [
      name,
      (...args) => calls.push({ name, args }),
    ]),
  );
  acceptanceSafety.installElectronSpawnGuard(childProcess, environment);
  const args = [
    '/owned/fixture.cjs',
    '--mode=reopen',
    '--scratch=/owned/fixture',
  ];
  const options = { env: { ...environment }, stdio: 'pipe', shell: false };
  const callback = () => {};
  for (const name of Object.keys(childProcess)) {
    childProcess[name](executable, args, options, callback);
    const call = calls.at(-1);
    assert.equal(call.name, name);
    assert.equal(call.args[0], executable);
    assert.match(call.args[1][0], /mac-acceptance-electron\.cjs$/);
    assert.deepEqual(call.args[1].slice(1), args);
    assert.equal(call.args[2], options);
    assert.equal(call.args[3], callback);
    assert.throws(
      () => childProcess[name](executable, args, { env: {} }),
      /lost guard configuration/,
    );
    assert.throws(
      () => childProcess[name](executable, args, { shell: true }),
      /must not run through a shell/,
    );
    assert.throws(
      () => childProcess[name]('/owned/App.app/Contents/MacOS/App', []),
      /unrecognized or packaged/,
    );
  }
  childProcess.spawn('/owned/ffmpeg', ['-version'], options);
  assert.deepEqual(calls.at(-1).args, ['/owned/ffmpeg', ['-version'], options]);
  assert.throws(
    () => acceptanceSafety.guardedElectronArguments(['--version']),
    /explicit test entry/,
  );
});

test('safeStorage guard never calls native methods and persists blocked attempts even when caught', async (t) => {
  const directory = await scratch(t);
  const output = execFileSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const { readFileSync } = require('node:fs');
    const { installSafeStorageGuard } = require('./scripts/mac-acceptance-safety.cjs');
    let nativeCalls = 0;
    const native = () => { nativeCalls++; throw new Error('Native method must never run'); };
    const safeStorage = { isEncryptionAvailable: native, encryptString: native, decryptString: native };
    const guard = installSafeStorageGuard(safeStorage, { directory: process.argv[1], stage: 'node-only', entry: 'fake-entry' });
    assert.equal(safeStorage.isEncryptionAvailable(), false);
    assert.throws(() => safeStorage.encryptString('synthetic'), /forbids native/);
    assert.throws(() => safeStorage.decryptString(Buffer.from('synthetic')), /forbids native/);
    assert.equal(nativeCalls, 0);
    assert.equal(Reflect.set(safeStorage, 'encryptString', native), false);
    const proof = JSON.parse(readFileSync(guard.report, 'utf8'));
    assert.equal(proof.installed, true);
    assert.equal(proof.availabilityChecks, 1);
    assert.equal(proof.encryptAttempts, 1);
    assert.equal(proof.decryptAttempts, 1);
    assert.equal(proof.nativeSecureStorage, 'not-tested');
    console.log('PASS no native method called');
  `,
      directory,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.match(output, /PASS no native method called/);
});

test('Node command executor persists both streams and an actual failing exit code', async (t) => {
  const directory = await scratch(t);
  const stdoutPath = join(directory, 'stdout');
  const stderrPath = join(directory, 'stderr');
  const outcome = await executeAcceptanceCommand({
    command: process.execPath,
    args: [
      '-e',
      'console.log("node-only"); console.error("diagnostic"); process.exitCode = 7',
    ],
    cwd: root,
    env: process.env,
    stdoutPath,
    stderrPath,
    timeoutMs: 5000,
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.exitCode, 7);
  assert.match(await readFile(stdoutPath, 'utf8'), /node-only/);
  assert.match(await readFile(stderrPath, 'utf8'), /diagnostic/);
});

test('cleanup permission errors remain separate from the command failure and cannot pass', async (t) => {
  const directory = await scratch(t);
  const originalKill = process.kill;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid < 0)
      throw Object.assign(new Error('fixture cleanup denied'), {
        code: 'EPERM',
      });
    return originalKill(pid, signal);
  });
  for (const code of [7, 0]) {
    const outcome = await executeAcceptanceCommand({
      command: process.execPath,
      args: ['-e', `process.exitCode = ${code}`],
      cwd: root,
      env: process.env,
      stdoutPath: join(directory, `${code}.stdout`),
      stderrPath: join(directory, `${code}.stderr`),
      timeoutMs: 5000,
    });
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.exitCode, code);
    assert.equal(outcome.cleanupError.code, 'EPERM');
    assert.match(
      outcome.reason,
      code === 7
        ? /Command exited with code 7/
        : /Could not terminate owned descendants/,
    );
  }
});

test('Node-only timeout and interrupt stop the owned process group and preserve output', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await scratch(t);
  for (const mode of ['timeout', 'interrupt']) {
    const controller = new AbortController();
    const timer =
      mode === 'interrupt' ? setTimeout(() => controller.abort(), 300) : null;
    try {
      const stdoutPath = join(directory, `${mode}.stdout`);
      const outcome = await executeAcceptanceCommand({
        command: process.execPath,
        args: ['-e', 'console.log(process.pid); setInterval(() => {}, 1000)'],
        cwd: root,
        env: process.env,
        stdoutPath,
        stderrPath: join(directory, `${mode}.stderr`),
        timeoutMs: mode === 'timeout' ? 300 : 5000,
        signal: controller.signal,
        graceMs: 100,
      });
      assert.equal(
        outcome.status,
        mode === 'timeout' ? 'timed-out' : 'interrupted',
      );
      const pid = Number((await readFile(stdoutPath, 'utf8')).trim());
      // Busy aggregate suites may reach the deadline before Node initializes.
      // If the child emitted its PID, also verify that it no longer exists.
      if (pid > 0) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      clearTimeout(timer);
    }
  }
});

test('package discovery selects only the unique new app and refuses stale, ambiguous or symlinked output', async (t) => {
  const directory = await scratch(t);
  const output = join(directory, 'new-run');
  const put = async (base) => {
    const binary = join(
      base,
      'Infinite Afflatus.app',
      'Contents',
      'MacOS',
      'Infinite Afflatus',
    );
    await mkdir(join(binary, '..'), { recursive: true });
    await writeFile(binary, 'test fixture, never executed');
    await chmod(binary, 0o755);
    return binary;
  };
  await put(join(directory, 'stale-run', 'mac-arm64'));
  await mkdir(output);
  await assert.rejects(
    resolveNewPackagedExecutable(output, 'Infinite Afflatus'),
    /found 0/,
  );
  const executable = await put(join(output, 'mac-arm64'));
  assert.equal(
    await resolveNewPackagedExecutable(output, 'Infinite Afflatus'),
    executable,
  );
  await put(join(output, 'mac'));
  await assert.rejects(
    resolveNewPackagedExecutable(output, 'Infinite Afflatus'),
    /found 2/,
  );
  const link = join(directory, 'linked-output');
  await symlink(output, link, 'dir');
  await assert.rejects(
    resolveNewPackagedExecutable(link, 'Infinite Afflatus'),
    /non-symlink/,
  );
});
