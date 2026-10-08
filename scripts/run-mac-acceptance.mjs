import { execFileSync, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createMacAcceptancePlan,
  parseMacAcceptanceArguments,
  runAcceptanceStages,
} from './mac-acceptance-plan.mjs';
import acceptanceSafety from './mac-acceptance-safety.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const safetyPreload = join(root, 'scripts/mac-acceptance-safety.cjs');

export function applyAcceptanceSafetyBoundaries(plan) {
  const probe = {
    id: 'preflight-safe-storage',
    runner: 'electron',
    args: ['scripts/mac-acceptance-guard-probe.cjs'],
    dependsOn: ['preflight-electron'],
    timeoutMs: 30_000,
    safeStorageGuard: true,
  };
  plan.stages.splice(2, 0, probe);
  for (const stage of plan.stages) {
    if (
      /^(?:renderer-|desktop-|media-resources-|real-media-delivery$)/.test(
        stage.id,
      )
    ) {
      stage.safeStorageGuard = true;
      stage.dependsOn.push(probe.id);
    }
    if (stage.id === 'packaged-smoke')
      stage.safetyBlockReason =
        'Not run: packaged Electron has no verified pre-main safeStorage guard. Native secure storage remains untested; do not launch this app under the no-Keychain constraint.';
  }
  plan.manual.push({
    id: 'native-secure-storage',
    status: 'not-run',
    detail:
      'Automated unpackaged checks force safeStorage unavailable and prohibit encryption/decryption. They do not test real Keychain persistence; packaged smoke is not launched.',
  });
  return plan;
}

export function acceptanceEnvironment(source, reportsDirectory) {
  const env = { ...source };
  // Every fixture owns its profile/library. Do not inherit application paths,
  // provider credentials, signing settings or optional media opt-ins.
  for (const name of Object.keys(env))
    if (/^(?:AFFLATUS_|ARK_|VOLC|CSC_|WIN_CSC_|APPLE_)/.test(name))
      delete env[name];
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  env.AFFLATUS_MEDIA_TESTS = '0';
  env.AFFLATUS_MEDIA_RESOURCE_REPORTS = reportsDirectory;
  env.COREPACK_ENABLE_NETWORK = '0';
  env.npm_config_manage_package_manager_versions = 'false';
  env.npm_config_offline = 'true';
  env.ELECTRON_SKIP_BINARY_DOWNLOAD = '1';
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  return env;
}

// Each command gets its own process group. Never use killall/pkill or attach
// to an existing app. Logs remain even when the command fails to start.
export async function executeAcceptanceCommand({
  command,
  args,
  cwd,
  env,
  stdoutPath,
  stderrPath,
  timeoutMs,
  signal,
  graceMs = 5000,
}) {
  const stdout = await open(stdoutPath, 'a');
  let stderr;
  try {
    stderr = await open(stderrPath, 'a');
    if (signal?.aborted)
      return { status: 'interrupted', reason: 'Interrupted before spawn.' };
    return await new Promise((done) => {
      let timedOut = false;
      let interrupted = false;
      let spawnError;
      let cleanupError;
      let forceTimer;
      const child = spawn(command, args, {
        cwd,
        env,
        detached: true,
        stdio: ['ignore', stdout.fd, stderr.fd],
      });
      const stopGroup = (value) => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, value);
        } catch (error) {
          if (error.code !== 'ESRCH') cleanupError ??= error;
        }
      };
      const terminate = () => {
        stopGroup('SIGTERM');
        forceTimer ??= setTimeout(() => stopGroup('SIGKILL'), graceMs);
      };
      const abort = () => {
        interrupted = true;
        terminate();
      };
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);
      child.once('error', (error) => {
        spawnError = error;
      });
      child.once('close', (code, exitSignal) => {
        clearTimeout(timeout);
        clearTimeout(forceTimer);
        signal?.removeEventListener('abort', abort);
        // A harness can exit before its descendants; they still belong to this
        // detached group. Terminate only that group's remaining children.
        stopGroup('SIGKILL');
        done({
          status: interrupted
            ? 'interrupted'
            : timedOut
              ? 'timed-out'
              : code === 0 && !spawnError && !cleanupError
                ? 'passed'
                : 'failed',
          exitCode: code,
          signal: exitSignal,
          ...(cleanupError
            ? {
                cleanupError: {
                  code: cleanupError.code,
                  message: cleanupError.message,
                },
              }
            : {}),
          ...(timedOut
            ? { reason: `Stage exceeded ${timeoutMs} ms.` }
            : interrupted
              ? {
                  reason:
                    'Batch interrupted; owned child process group stopped.',
                }
              : spawnError
                ? { reason: spawnError.message }
                : code !== 0
                  ? {
                      reason: `Command exited with ${exitSignal ? `signal ${exitSignal}` : `code ${code}`}; see stage logs.`,
                    }
                  : cleanupError
                    ? {
                        reason: `Could not terminate owned descendants: ${cleanupError.message}`,
                      }
                    : {}),
        });
      });
      if (signal?.aborted) abort();
    });
  } finally {
    await Promise.all([stdout.close(), stderr?.close()]);
  }
}

// Search only the output created by this invocation, never the shared release
// root or a previous build. Refuse ambiguous output and symlinked candidates.
export async function resolveNewPackagedExecutable(directory, productName) {
  const candidates = [];
  const inspect = async (parent, depth) => {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(
        'Package output must be an owned, non-symlink directory.',
      );
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.name.startsWith('.')
      )
        continue;
      const path = join(parent, entry.name);
      if (entry.name.endsWith('.app')) {
        const executable = join(path, 'Contents', 'MacOS', productName);
        for (const part of [
          join(path, 'Contents'),
          join(path, 'Contents', 'MacOS'),
          executable,
        ]) {
          const stat = await lstat(part);
          if (stat.isSymbolicLink())
            throw new Error('Packaged executable path contains a symlink.');
        }
        if (!(await lstat(executable)).isFile())
          throw new Error('Packaged executable is not a regular file.');
        await access(executable, constants.X_OK);
        candidates.push(executable);
      } else if (depth > 0) await inspect(path, depth - 1);
    }
  };
  await inspect(directory, 1);
  if (candidates.length !== 1)
    throw new Error(
      `Expected exactly one newly built app; found ${candidates.length}.`,
    );
  return candidates[0];
}

const readVersion = async (file) => (await readFile(file, 'utf8')).trim();

export async function main(args = process.argv.slice(2)) {
  const options = parseMacAcceptanceArguments(args, process.env);
  const plan = applyAcceptanceSafetyBoundaries(
    createMacAcceptancePlan(options),
  );
  if (options.planOnly) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  if (process.platform !== 'darwin') {
    console.error(
      'Mac acceptance requires native macOS. Use --plan on this OS; no build, Electron launch or package was attempted.',
    );
    return 2;
  }
  const require = createRequire(join(root, 'package.json'));
  const metadata = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  );
  for (const directory of [
    join(root, 'release'),
    join(root, 'release', 'acceptance'),
  ]) {
    await mkdir(directory, { recursive: true });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Acceptance report parent must not be a symlink.');
  }
  const runDirectory = await mkdtemp(
    join(
      root,
      'release',
      'acceptance',
      `${new Date().toISOString().replace(/[:.]/g, '-')}-`,
    ),
  );
  const packageOutput = join(runDirectory, 'package');
  const env = acceptanceEnvironment(
    process.env,
    join(runDirectory, 'media-resources'),
  );
  const query = (command, values) => {
    try {
      return execFileSync(command, values, {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return null;
    }
  };
  const gitState = query('git', ['status', '--porcelain']);
  const versions = {
    node: process.version,
    pnpm: query('pnpm', ['--version']),
    application: metadata.version,
    electronExpected: metadata.devDependencies.electron,
    electronPackage: null,
    electronRuntime: null,
  };
  plan.environment = {
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    macOSVersion: query('/usr/bin/sw_vers', ['-productVersion']),
    commit: query('git', ['rev-parse', 'HEAD']),
    dirty: gitState === null ? null : gitState.length > 0,
    versions,
  };
  plan.outputDirectory = runDirectory;
  for (const stage of plan.stages) {
    stage.stdoutPath = join(runDirectory, `${stage.id}.stdout.log`);
    stage.stderrPath = join(runDirectory, `${stage.id}.stderr.log`);
    await writeFile(stage.stdoutPath, '', { flag: 'wx' });
    await writeFile(stage.stderrPath, '', { flag: 'wx' });
  }
  let electron;
  let packagedExecutable;
  const controller = new AbortController();
  let interruptSignal;
  const interrupt = (signal) => {
    interruptSignal = signal;
    controller.abort();
  };
  const onInterrupt = () => interrupt('SIGINT');
  const onTerminate = () => interrupt('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  const persist = async (report) => {
    const temporary = join(runDirectory, 'report.json.tmp');
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
    await rename(temporary, join(runDirectory, 'report.json'));
    for (const stage of report.stages)
      await writeFile(
        join(runDirectory, `${stage.id}.json`),
        `${JSON.stringify(stage, null, 2)}\n`,
      );
  };
  const execute = async (stage, signal) => {
    console.log(`Running ${stage.id}`);
    if (stage.safetyBlockReason)
      return { status: 'blocked', reason: stage.safetyBlockReason };
    if (stage.runner === 'preflight-code') {
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major !== 24 || minor < 14)
        return {
          status: 'blocked',
          reason: 'Use Node.js >=24.14.0 <25, then rerun pnpm test:mac.',
        };
      if (!versions.pnpm)
        return {
          status: 'blocked',
          reason:
            'Make the package.json-pinned pnpm available first; automatic installation/network setup is disabled.',
        };
      try {
        for (const name of [
          'tsx',
          'typescript',
          'electron-vite',
          'electron-builder',
        ])
          require.resolve(name);
      } catch {
        return {
          status: 'blocked',
          reason:
            'Required dependencies are missing. Run pnpm install --frozen-lockfile as a separate approved setup step, then rerun pnpm test:mac.',
        };
      }
      await writeFile(
        stage.stdoutPath,
        `${JSON.stringify(versions, null, 2)}\n`,
      );
      return { status: 'passed' };
    }
    if (stage.runner === 'preflight-electron') {
      try {
        const packageFile = require.resolve('electron/package.json');
        versions.electronPackage = JSON.parse(
          await readFile(packageFile, 'utf8'),
        ).version;
        versions.electronRuntime = await readVersion(
          join(dirname(packageFile), 'dist', 'version'),
        );
        electron = require('electron');
        if (
          typeof electron !== 'string' ||
          !electron.endsWith('/Electron.app/Contents/MacOS/Electron') ||
          versions.electronPackage !== versions.electronExpected ||
          versions.electronRuntime !== versions.electronExpected
        )
          throw new Error('Missing or mismatched native Electron runtime.');
        await access(electron, constants.X_OK);
      } catch {
        return {
          status: 'blocked',
          reason:
            'The pinned native Electron runtime is missing or mismatched. Run pnpm exec install-electron separately on this Mac after approving runtime setup, then rerun pnpm test:mac. This runner does not download it.',
        };
      }
      await writeFile(
        stage.stdoutPath,
        `${JSON.stringify({ executable: electron, version: versions.electronRuntime }, null, 2)}\n`,
      );
      return { status: 'passed' };
    }
    if (stage.runner === 'resolve-package') {
      packagedExecutable = await resolveNewPackagedExecutable(
        packageOutput,
        metadata.productName,
      );
      await writeFile(stage.stdoutPath, `${packagedExecutable}\n`);
      return { status: 'passed', executable: packagedExecutable };
    }
    const command =
      stage.runner === 'pnpm'
        ? 'pnpm'
        : stage.runner === 'electron'
          ? electron
          : process.execPath;
    let commandArgs = stage.args.map((arg) =>
      arg === '<new-run-directory>/package'
        ? packageOutput
        : arg === '<exact-newly-built-app-executable>'
          ? packagedExecutable
          : arg,
    );
    const stageEnvironment = {
      ...env,
      AFFLATUS_MEDIA_TESTS: stage.realMedia ? '1' : '0',
    };
    let guardReports;
    if (stage.safeStorageGuard) {
      guardReports = join(runDirectory, 'safe-storage', stage.id);
      await mkdir(guardReports, { recursive: true });
      Object.assign(stageEnvironment, {
        AFFLATUS_TEST_ELECTRON_EXECUTABLE: electron,
        AFFLATUS_TEST_SAFE_STORAGE_REPORTS: guardReports,
        AFFLATUS_TEST_STAGE: stage.id,
      });
      commandArgs =
        stage.runner === 'electron'
          ? acceptanceSafety.guardedElectronArguments(commandArgs)
          : ['--require', safetyPreload, ...commandArgs];
    }
    stage.command = { executable: command, args: commandArgs };
    const outcome = await executeAcceptanceCommand({
      command,
      args: commandArgs,
      cwd: root,
      env: stageEnvironment,
      stdoutPath: stage.stdoutPath,
      stderrPath: stage.stderrPath,
      timeoutMs: stage.timeoutMs,
      signal,
    });
    if (guardReports) {
      const evidence = [];
      for (const file of await readdir(guardReports))
        if (file.endsWith('.json'))
          evidence.push(
            JSON.parse(await readFile(join(guardReports, file), 'utf8')),
          );
      outcome.secureStorage = {
        nativeSecureStorage: 'not-tested',
        guardedProcesses: evidence.length,
        reportsDirectory: guardReports,
        availabilityChecks: evidence.reduce(
          (sum, item) => sum + item.availabilityChecks,
          0,
        ),
        encryptAttempts: evidence.reduce(
          (sum, item) => sum + item.encryptAttempts,
          0,
        ),
        decryptAttempts: evidence.reduce(
          (sum, item) => sum + item.decryptAttempts,
          0,
        ),
      };
      const installed =
        evidence.length > 0 &&
        evidence.every(
          (item) => item.installed === true && item.stage === stage.id,
        );
      const probe = stage.id === 'preflight-safe-storage';
      const valid =
        installed &&
        (probe
          ? evidence.length === 1 &&
            outcome.secureStorage.availabilityChecks === 1 &&
            outcome.secureStorage.encryptAttempts === 1 &&
            outcome.secureStorage.decryptAttempts === 1
          : outcome.secureStorage.encryptAttempts === 0 &&
            outcome.secureStorage.decryptAttempts === 0);
      if (!valid)
        return {
          ...outcome,
          status: 'failed',
          reason:
            'safeStorage guard evidence missing/invalid or a prohibited encryption/decryption was attempted; see per-process evidence.',
        };
    }
    return outcome;
  };
  console.log(`Mac acceptance report: ${join(runDirectory, 'report.json')}`);
  try {
    const report = await runAcceptanceStages({
      plan,
      execute,
      persist,
      signal: controller.signal,
    });
    console.log(
      `Selected automated checks: ${report.automatedStatus}. Manual/release acceptance remains separate.\nReport: ${join(runDirectory, 'report.json')}`,
    );
    return interruptSignal
      ? interruptSignal === 'SIGINT'
        ? 130
        : 143
      : report.status === 'completed'
        ? 0
        : 1;
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
