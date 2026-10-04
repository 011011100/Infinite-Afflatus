import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { test } from 'node:test';
import { createPackage } from '@electron/asar';
import { stageApplication } from '../scripts/package-content.mjs';
import { verifyAsar } from '../scripts/verify-package.mjs';

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
