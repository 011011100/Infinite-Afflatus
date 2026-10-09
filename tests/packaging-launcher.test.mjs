import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { posix, win32 } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

// Exercise the production argument expression without starting a native packager.
const source = readFileSync(
  new URL('../scripts/package-desktop.mjs', import.meta.url),
  'utf8',
);
const expression = source.match(/const args = (\[[\s\S]*?\n {2}\]);/);
assert.ok(expression, 'Update this test if the packager argument block moves');

function argumentsFor({ root, paths, windows, resolve, mode = 'local' }) {
  return Array.from(
    runInNewContext(expression[1], {
      require: { resolve },
      pathToFileURL: (path) => pathToFileURL(path, { windows }),
      join: paths.join,
      root,
      appStaging: paths.join(root, 'staging', 'app'),
      release: paths.join(root, 'release'),
      electronDist: paths.join(root, 'electron', 'dist'),
      process: { arch: 'x64' },
      mode,
    }),
  );
}

for (const target of [
  {
    name: 'Windows',
    root: 'D:\\build folder\\Afflatus #1%',
    paths: win32,
    windows: true,
  },
  {
    name: 'macOS',
    root: '/Users/build folder/Afflatus #1%',
    paths: posix,
    windows: false,
  },
]) {
  test(`native ${target.name} packaging imports the resolved loader as a file URL`, () => {
    const loader = target.paths.join(
      target.root,
      'node_modules',
      'tsx',
      'loader.mjs',
    );
    const builder = target.paths.join(
      target.root,
      'node_modules',
      'electron-builder',
      'cli.js',
    );
    for (const mode of ['local', 'dir']) {
      const args = argumentsFor({
        ...target,
        mode,
        resolve: (name) => (name === 'tsx' ? loader : builder),
      });
      assert.equal(args[0], '--import');
      const url = new URL(args[1]);
      assert.equal(url.protocol, 'file:');
      assert.equal(url.hash, '');
      assert.equal(url.search, '');
      assert.equal(fileURLToPath(url, { windows: target.windows }), loader);
      assert.equal(args[2], builder, 'the CLI entry remains a native path');
      assert.equal(
        args[args.indexOf('--config') + 1],
        target.paths.join(target.root, 'electron-builder.config.cjs'),
      );
      assert.equal(args[args.indexOf('--publish') + 1], 'never');
      assert.ok(args.includes('--x64'));
      assert.equal(args.includes('--dir'), mode === 'dir');
    }
  });
}

test('Node starts with the installed tsx loader using the production import argument', () => {
  const require = createRequire(import.meta.url);
  const args = argumentsFor({
    root: fileURLToPath(new URL('..', import.meta.url)),
    paths: process.platform === 'win32' ? win32 : posix,
    windows: process.platform === 'win32',
    resolve: require.resolve,
  });
  const output = execFileSync(
    process.execPath,
    [...args.slice(0, 2), '--eval', "console.log('packaging-loader-ready')"],
    { encoding: 'utf8' },
  );
  assert.equal(output.trim(), 'packaging-loader-ready');
});
