// Supplemental native IPC/service proof. Run with Node after the coordinated build.
// The child always uses the pre-main safeStorage guard; no live provider is used.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptanceEnvironment,
  executeAcceptanceCommand,
} from '../../scripts/run-mac-acceptance.mjs';
import { syntheticTrimVideo } from './synthetic-trim-video.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const bootstrap = fileURLToPath(
  new URL('./mac-generation-staging-bootstrap.cjs', import.meta.url),
);
const {
  guardedElectronArguments,
} = require('../../scripts/mac-acceptance-safety.cjs');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const electron = require('electron');
const externalSpawnGuard = process.env.AFFLATUS_TEST_ELECTRON_EXECUTABLE;
if (externalSpawnGuard) {
  assert.equal(
    externalSpawnGuard,
    electron,
    'Parent guard must pin this Electron',
  );
  assert.ok(
    process.env.AFFLATUS_TEST_SAFE_STORAGE_REPORTS &&
      process.env.AFFLATUS_TEST_STAGE,
  );
}
assert.equal(
  process.platform,
  'darwin',
  'This supplemental acceptance is Mac-only',
);
for (const file of ['out/preload/index.cjs', bootstrap])
  assert.ok(existsSync(file.startsWith('/') ? file : join(root, file)), file);
const base = await realpath(
  await mkdtemp(join(tmpdir(), 'afflatus-native-generation-')),
);
for (const directory of [
  'profile',
  'projects',
  'moved',
  'cloud',
  'inputs',
  'safety',
])
  await mkdir(join(base, directory));
await writeFile(join(base, '.fixture-owner'), randomUUID(), { flag: 'wx' });
const text = '完整接收但尚未保存的中文参考。\n迁移和重启不改变内容。';
const wave = Buffer.alloc(44 + 48000 * 2);
wave.write('RIFF', 0);
wave.writeUInt32LE(wave.length - 8, 4);
wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(48000, 24);
wave.writeUInt32LE(96000, 28);
wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34);
wave.write('data', 36);
wave.writeUInt32LE(wave.length - 44, 40);
const inputs = [
  [
    'image',
    'reference.png',
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
      'base64',
    ),
  ],
  ['video', 'reference.mp4', syntheticTrimVideo],
  ['audio', 'reference.wav', wave],
  ['text', 'reference.txt', Buffer.from(text)],
];
const manifest = [];
for (const [kind, name, bytes] of inputs) {
  await writeFile(join(base, 'inputs', name), bytes, { flag: 'wx' });
  manifest.push({ kind, name, size: bytes.length, sha256: hash(bytes) });
}
await writeFile(join(base, 'inputs.json'), JSON.stringify({ manifest, text }), {
  flag: 'wx',
});
await writeFile(
  join(base, 'native.html'),
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src afflatus-media:; media-src afflatus-media:; connect-src afflatus-media:;"><title>隔离原生链路验收</title><body>隔离原生链路验收</body></html>',
  { flag: 'wx' },
);

const report = {
  schemaVersion: 1,
  fixture: 'mac-generation-staging',
  base,
  expectedGuardedProcesses: 2,
  scope:
    'Production preload, generation/Ark IPC, Library, media protocol and Ark service in an isolated test composition; main Electron net.fetch verifies media bytes/HEAD/Range, renderer media elements decode independently; synthetic media, transport and secret store.',
  notCovered: [
    'Renderer fetch/CORS access to the media scheme.',
    'Production main startup composition and production renderer controls (covered separately).',
    'Real Ark API, uploads, credentials, native Keychain, signing and installation.',
    'Interrupted/unsaved process restart, streaming abort/lease release and simultaneous save cleanup.',
    'Root unavailability, mid-copy/cutover read races and filesystem case sensitivity.',
  ],
  stages: [],
};
const reportPath = join(base, 'report.json');
console.log(`Supplemental native acceptance evidence: ${base}`);
const persist = () =>
  writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
await persist();
for (const mode of ['configure', 'reopen']) {
  const env = acceptanceEnvironment(process.env, base);
  Object.assign(env, {
    AFFLATUS_USER_DATA: join(base, 'profile'),
    AFFLATUS_PROJECTS_DIR: join(base, 'projects'),
    AFFLATUS_TEST_SAFE_STORAGE_REPORTS: externalSpawnGuard
      ? process.env.AFFLATUS_TEST_SAFE_STORAGE_REPORTS
      : join(base, 'safety'),
    AFFLATUS_TEST_STAGE: externalSpawnGuard
      ? process.env.AFFLATUS_TEST_STAGE
      : `supplemental-native-${mode}`,
  });
  const safetyDirectory = env.AFFLATUS_TEST_SAFE_STORAGE_REPORTS;
  const previousSafetyFiles = new Set(await readdir(safetyDirectory));
  const args = [bootstrap, `--scratch=${base}`, `--mode=${mode}`];
  const result = await executeAcceptanceCommand({
    command: electron,
    // A parent's preloaded guard wraps these arguments itself. Never wrap twice.
    args: externalSpawnGuard ? args : guardedElectronArguments(args),
    cwd: root,
    env,
    stdoutPath: join(base, `${mode}.stdout.log`),
    stderrPath: join(base, `${mode}.stderr.log`),
    timeoutMs: 120000,
  });
  try {
    const newSafetyFiles = (await readdir(safetyDirectory)).filter(
      (name) => name.endsWith('.json') && !previousSafetyFiles.has(name),
    );
    assert.equal(
      newSafetyFiles.length,
      1,
      'One guarded Electron process per phase',
    );
    const safetyPath = join(safetyDirectory, newSafetyFiles[0]);
    const safety = JSON.parse(await readFile(safetyPath, 'utf8'));
    assert.equal(safety.installed, true);
    assert.equal(safety.stage, env.AFFLATUS_TEST_STAGE);
    assert.equal(safety.entry, bootstrap);
    assert.equal(safety.encryptAttempts, 0);
    assert.equal(safety.decryptAttempts, 0);
    assert.equal(safety.nativeSecureStorage, 'not-tested');
    result.safeStorage = { report: safetyPath, ...safety };
  } catch (error) {
    result.status = 'failed';
    result.reason = `Incomplete safeStorage guard proof: ${error.message}`;
  }
  report.stages.push({ mode, ...result });
  await persist();
  if (result.status !== 'passed') {
    if (result.reason) console.error(result.reason);
    console.error(await readFile(join(base, `${mode}.stderr.log`), 'utf8'));
    process.exitCode = 1;
    break;
  }
  console.log(await readFile(join(base, `${mode}.stdout.log`), 'utf8'));
}
for (const item of manifest)
  assert.equal(
    hash(await readFile(join(base, 'inputs', item.name))),
    item.sha256,
    'Synthetic source bytes unchanged',
  );
report.status =
  report.stages.length === 2 &&
  report.stages.every((item) => item.status === 'passed')
    ? 'passed'
    : 'failed';
await persist();
console.log(`Supplemental native acceptance ${report.status}: ${reportPath}`);
