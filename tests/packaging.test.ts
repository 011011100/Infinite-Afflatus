import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep, win32 } from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createPackage, extractFile, getRawHeader } from '@electron/asar';
import { stageApplication } from '../scripts/package-content.mjs';
import { stageMediaToolBundle } from '../scripts/package-media-tools.mjs';
import { verifyAsar, verifyPackagedApp } from '../scripts/verify-package.mjs';
import { mediaToolBundleFixture } from './media-tool-bundle-fixture';

async function archive(source: string, destination: string) {
  // ASAR 3.4.1 returns the output stream from end(), despite declaring Promise<void>.
  // Wait for its writes before the synchronous reader checks the final archive.
  const output: unknown = await createPackage(source, destination);
  assert.ok(output instanceof Writable);
  await finished(output);
}

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'afflatus-packaging-'));
  const root = join(base, 'project');
  const stage = join(base, 'stage');
  const put = async (path: string, value: string) => {
    const destination = join(root, path);
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, value);
  };
  await put(
    'package.json',
    JSON.stringify({
      name: 'infinite-afflatus',
      productName: 'Infinite Afflatus',
      version: '0.1.0',
      description: 'test',
      type: 'module',
      main: './out/main/index.js',
      scripts: { private: 'do not distribute' },
      dependencies: { react: 'test' },
      devDependencies: { electron: 'test' },
    }),
  );
  await put(
    'out/main/index.js',
    "import { app } from 'electron'; import { DatabaseSync } from 'node:sqlite'; const labels = { import: 'package:import', from: 'not-a-dependency' }; const icon = './chunks/app-icon-test.png';",
  );
  await put('out/main/chunks/app-icon-test.png', 'existing icon bytes');
  await put('out/preload/index.cjs', "const electron = require('electron');");
  await put(
    'out/renderer/index.html',
    '<script src="./assets/app.js"></script><link href="./assets/app.css"><link href="./app-icon.png">',
  );
  await put('out/renderer/assets/app.js', 'window.ready = true;');
  await put('out/renderer/assets/app.css', 'body {}');
  await put('out/renderer/app-icon.png', 'existing icon bytes');
  return {
    base,
    root,
    stage,
    put,
    clean: () => rm(base, { recursive: true, force: true }),
  };
}

test('staging and real ASAR round-trip include runtime files without workspace secrets or bundled dependencies', async (t) => {
  const f = await fixture();
  t.after(f.clean);
  await f.put('.env', 'private');
  await f.put('tests/private.sqlite', 'private');
  await f.put('node_modules/private/data.txt', 'private');
  await f.put('docs/private.md', 'private');
  const files = await stageApplication(f.root, f.stage);
  assert.equal(files.length, 8);
  assert.deepEqual((await readdir(f.stage)).sort(), ['out', 'package.json']);
  const metadata = JSON.parse(
    await readFile(join(f.stage, 'package.json'), 'utf8'),
  );
  assert.equal(metadata.dependencies, undefined);
  assert.equal(metadata.devDependencies, undefined);
  assert.equal(metadata.scripts, undefined);
  const file = join(f.base, 'app.asar');
  await archive(f.stage, file);
  assert.deepEqual(verifyAsar(file), { asar: file, files: 8 });
});

test('the final ASAR validator rejects private files added after staging', async (t) => {
  const f = await fixture();
  t.after(f.clean);
  await stageApplication(f.root, f.stage);
  await writeFile(join(f.stage, '.env'), 'private');
  const file = join(f.base, 'app.asar');
  await archive(f.stage, file);
  assert.throws(() => verifyAsar(file), /Unexpected packaged file/);
});

test('the ASAR validator uses native Windows paths for both nested tree lookup and extraction', async (t) => {
  const f = await fixture();
  t.after(f.clean);
  await stageApplication(f.root, f.stage);
  const archive = join(f.base, 'app.asar');
  await finished(await createPackage(f.stage, archive));
  // Execute the installed library's actual tree traversal with Windows path semantics.
  // Only disk extraction returns to the host path format after Windows lookup succeeds.
  const require = createRequire(import.meta.url);
  const source = require.resolve('@electron/asar/lib/filesystem.js');
  const moduleRequire = createRequire(source);
  const runtime = {
    exports: {} as typeof import('@electron/asar/lib/filesystem.js'),
  };
  const load = runInNewContext(
    `(function(require, module, exports) { ${readFileSync(source, 'utf8')}\n })`,
    { Buffer, process },
  );
  load(
    (name: string) => (name === 'path' ? win32 : moduleRequire(name)),
    runtime,
    runtime.exports,
  );
  const filesystem = new runtime.exports.Filesystem('C:\\staged');
  const { header, headerSize } = getRawHeader(archive);
  filesystem.setHeader(structuredClone(header), headerSize);
  assert.throws(
    () => filesystem.getFile('out/main/chunks', false),
    /not found/,
  );
  filesystem.setHeader(structuredClone(header), headerSize);
  const lookups: string[] = [];
  const reads: string[] = [];
  assert.deepEqual(
    verifyAsar(archive, {
      listPackage: () => filesystem.listFiles(),
      statFile: (_archive, file, followLinks) => {
        lookups.push(file);
        return filesystem.getFile(file, followLinks);
      },
      extractFile: (_archive, file, followLinks) => {
        reads.push(file);
        filesystem.getFile(file, followLinks);
        return extractFile(archive, file.replaceAll('\\', sep), followLinks);
      },
    }),
    { asar: archive, files: 8 },
  );
  assert.ok(lookups.includes('out\\main\\chunks'));
  assert.ok(reads.includes('out\\main\\index.js'));
  assert.ok(reads.includes('out\\preload\\index.cjs'));
  assert.ok(reads.includes('out\\renderer\\index.html'));
});

test('staging refuses unbundled production imports instead of shipping a broken no-node_modules app', async (t) => {
  const f = await fixture();
  t.after(f.clean);
  await f.put(
    'out/main/index.js',
    "import something from 'unbundled-native-addon';",
  );
  await assert.rejects(
    stageApplication(f.root, f.stage),
    /Unbundled runtime dependency/,
  );
});

test('staging rejects missing or nonlocal renderer assets before packaging', async (t) => {
  const f = await fixture();
  t.after(f.clean);
  await f.put(
    'out/renderer/index.html',
    '<script src="http://localhost:5173/app.js"></script><link href="./assets/app.css">',
  );
  await assert.rejects(
    stageApplication(f.root, f.stage),
    /missing or non-local resource/,
  );
});

test('staging rejects symlinks and unexpected build output instead of following private input', async (t) => {
  const f = await fixture();
  t.after(f.clean);
  await f.put('out/renderer/assets/private.sqlite', 'private');
  await assert.rejects(
    stageApplication(f.root, f.stage),
    /Unexpected packaged file/,
  );
  await rm(join(f.root, 'out/renderer/assets/private.sqlite'));
  await f.put('private.js', 'private');
  await symlink(
    join(f.root, 'private.js'),
    join(f.root, 'out/renderer/assets/private.js'),
  );
  await assert.rejects(stageApplication(f.root, f.stage), /symbolic links/);
});

test('final resources verify optional external bundle while preserving strict ASAR and pinned supplied provenance', async (t) => {
  const f = await fixture();
  const bundle = await mediaToolBundleFixture();
  t.after(f.clean);
  t.after(bundle.clean);
  await stageApplication(f.root, f.stage);
  const appOutDir = join(f.base, 'unpacked');
  const resources = join(
    appOutDir,
    'Infinite Afflatus.app',
    'Contents',
    'Resources',
  );
  await mkdir(resources, { recursive: true });
  const asar = join(resources, 'app.asar');
  await archive(f.stage, asar);
  const options = { platform: 'darwin' as const, arch: 'arm64' };
  assert.deepEqual(await verifyPackagedApp(appOutDir, options), {
    asar,
    files: 8,
  });
  await assert.rejects(
    verifyPackagedApp(appOutDir, { ...options, requireMediaTools: true }),
    /missing/,
  );
  const destination = join(resources, 'media-tools');
  await stageMediaToolBundle(bundle.directory, destination, options);
  const result = await verifyPackagedApp(appOutDir, {
    ...options,
    requireMediaTools: true,
    expectedMediaToolManifest: bundle.manifest,
  });
  assert.equal(result.files, 8);
  assert.equal(result.mediaTools?.files, 4);
  assert.deepEqual(result.mediaTools?.manifest, bundle.manifest);
  await assert.rejects(
    verifyPackagedApp(appOutDir, { ...options, arch: 'x64' }),
    /target/,
  );
  const altered = {
    ...bundle.manifest,
    build: { ...bundle.manifest.build, version: 'other-build' },
  };
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(altered));
  await assert.rejects(
    verifyPackagedApp(appOutDir, {
      ...options,
      expectedMediaToolManifest: bundle.manifest,
    }),
    /differs from/,
  );
  await writeFile(
    join(destination, 'manifest.json'),
    JSON.stringify(bundle.manifest),
  );
  await writeFile(join(destination, 'private.txt'), 'must not ship');
  await assert.rejects(verifyPackagedApp(appOutDir, options), /undeclared/);
  await rm(join(destination, 'private.txt'));
  await writeFile(join(destination, 'bin/ffmpeg'), 'corrupt');
  await assert.rejects(verifyPackagedApp(appOutDir, options), /SHA-256/);
  await writeFile(join(destination, 'bin/ffmpeg'), 'inert ffmpeg fixture');
  await mkdir(join(resources, 'app.asar.unpacked'));
  await assert.rejects(
    verifyPackagedApp(appOutDir, options),
    /unpacked dependencies/,
  );
  await rm(join(resources, 'app.asar.unpacked'), { recursive: true });
  await writeFile(join(f.stage, 'ffmpeg'), 'must never enter ASAR');
  await archive(f.stage, asar);
  await assert.rejects(
    verifyPackagedApp(appOutDir, options),
    /Unexpected packaged file/,
  );
});

test('Windows final resources use the declared target and executable pair without host platform assumptions', async (t) => {
  const f = await fixture();
  const bundle = await mediaToolBundleFixture();
  t.after(f.clean);
  t.after(bundle.clean);
  bundle.manifest.target = { platform: 'win32', arch: 'x64' };
  await bundle.save();
  await stageApplication(f.root, f.stage);
  const appOutDir = join(f.base, 'win-unpacked');
  const resources = join(appOutDir, 'resources');
  await mkdir(resources, { recursive: true });
  await archive(f.stage, join(resources, 'app.asar'));
  const options = { platform: 'win32' as const, arch: 'x64' };
  await stageMediaToolBundle(
    bundle.directory,
    join(resources, 'media-tools'),
    options,
  );
  const result = await verifyPackagedApp(appOutDir, {
    ...options,
    requireMediaTools: true,
  });
  assert.equal(result.mediaTools?.manifest.target.platform, 'win32');
  assert.equal(result.mediaTools?.manifest.target.arch, 'x64');
});
