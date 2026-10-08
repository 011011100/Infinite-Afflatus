// Test-only guard. Never imported by production code or included in its bundle.
const { randomUUID } = require('node:crypto');
const { renameSync, writeFileSync } = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const { basename, isAbsolute, join, resolve } = require('node:path');

const marker = Symbol.for('afflatus.mac-acceptance.safe-storage');
const bootstrap = join(__dirname, 'mac-acceptance-electron.cjs');

function guardedElectronArguments(args) {
  if (!Array.isArray(args) || !args[0] || args[0].startsWith('-'))
    throw new Error('Guarded Electron requires an explicit test entry file.');
  return [bootstrap, ...args];
}

function installSafeStorageGuard(safeStorage, { directory, stage, entry }) {
  if (globalThis[marker]) throw new Error('safeStorage guard installed twice.');
  if (!directory || !isAbsolute(directory) || !stage || !entry)
    throw new Error('Missing isolated safeStorage evidence configuration.');
  const evidence = {
    schemaVersion: 1,
    pid: process.pid,
    stage,
    entry,
    installed: false,
    nativeSecureStorage: 'not-tested',
    availabilityChecks: 0,
    encryptAttempts: 0,
    decryptAttempts: 0,
  };
  const report = join(directory, `${process.pid}-${randomUUID()}.json`);
  const persist = () => {
    writeFileSync(`${report}.tmp`, `${JSON.stringify(evidence, null, 2)}\n`);
    renameSync(`${report}.tmp`, report);
  };
  const replacements = {
    isEncryptionAvailable() {
      evidence.availabilityChecks++;
      persist();
      return false;
    },
    encryptString() {
      evidence.encryptAttempts++;
      persist();
      throw new Error('Mac acceptance forbids native safeStorage encryption.');
    },
    decryptString() {
      evidence.decryptAttempts++;
      persist();
      throw new Error('Mac acceptance forbids native safeStorage decryption.');
    },
  };
  // Do not call, retain, or log the native functions or their arguments.
  for (const [name, value] of Object.entries(replacements)) {
    Object.defineProperty(safeStorage, name, {
      value,
      configurable: false,
      writable: false,
    });
    if (safeStorage[name] !== value)
      throw new Error(`Could not install safeStorage guard: ${name}`);
  }
  evidence.installed = true;
  persist();
  const state = Object.freeze({ report, snapshot: () => ({ ...evidence }) });
  Object.defineProperty(globalThis, marker, { value: state });
  console.log(`[acceptance-safe-storage] installed before entry: ${report}`);
  return state;
}

function installElectronSpawnGuard(childProcess, environment = process.env) {
  const executable = environment.AFFLATUS_TEST_ELECTRON_EXECUTABLE;
  if (!executable || !isAbsolute(executable))
    throw new Error('Missing pinned Electron executable for acceptance.');
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    const original = childProcess[name];
    childProcess[name] = function (file, args, ...rest) {
      if (typeof file === 'string' && resolve(file) === resolve(executable)) {
        if (rest[0]?.shell)
          throw new Error('Guarded Electron must not run through a shell.');
        const options = rest[0];
        const env = options?.env ?? environment;
        for (const key of [
          'AFFLATUS_TEST_SAFE_STORAGE_REPORTS',
          'AFFLATUS_TEST_STAGE',
        ])
          if (!env[key] || env[key] !== environment[key])
            throw new Error(`Electron child lost guard configuration: ${key}`);
        return original.call(
          this,
          file,
          guardedElectronArguments(args),
          ...rest,
        );
      }
      if (
        typeof file === 'string' &&
        (basename(file) === 'Electron' || file.includes('.app/Contents/MacOS/'))
      )
        throw new Error(
          'Refusing an unrecognized or packaged Electron launch.',
        );
      return original.call(this, file, args, ...rest);
    };
  }
  // Node ESM harnesses use named imports from node:child_process.
  syncBuiltinESMExports();
}

module.exports = {
  guardedElectronArguments,
  installElectronSpawnGuard,
  installSafeStorageGuard,
  marker,
};

// This preload only wraps Node harness launches. The Electron bootstrap installs
// safeStorage after Electron initialized its JS API, before loading any fixture.
if (!process.versions.electron && process.env.AFFLATUS_TEST_ELECTRON_EXECUTABLE)
  installElectronSpawnGuard(require('node:child_process'));
