import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageApplication } from './package-content.mjs';

const mode = process.argv[2];
if (!['dir', 'local'].includes(mode) || process.argv.length !== 3)
  throw new Error(
    'Use pnpm package:dir or pnpm package:local; publishing and signing are disabled',
  );
if (!['darwin', 'win32'].includes(process.platform))
  throw new Error(
    'Internal packaging currently supports native macOS and Windows builders',
  );
const root = fileURLToPath(new URL('../', import.meta.url));
const release = join(root, 'release');
await mkdir(release, { recursive: true });
const staging = await mkdtemp(join(release, '.app-staging-'));
const require = createRequire(import.meta.url);
try {
  await stageApplication(root, staging);
  const electronDist = join(
    dirname(require.resolve('electron/package.json')),
    'dist',
  );
  const metadata = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  );
  if (
    (await readFile(join(electronDist, 'version'), 'utf8')).trim() !==
    metadata.devDependencies.electron
  )
    throw new Error(
      'Installed Electron runtime differs from the pinned version; run pnpm exec install-electron',
    );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:CSC_|WIN_CSC_|APPLE_)/.test(name),
    ),
  );
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  const args = [
    require.resolve('electron-builder/cli.js'),
    '--config',
    join(root, 'electron-builder.config.cjs'),
    `-c.directories.app=${staging}`,
    `-c.electronDist=${electronDist}`,
    `--${process.arch}`,
    '--publish',
    'never',
    ...(mode === 'dir' ? ['--dir'] : []),
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`Packaging failed (${signal ?? code})`)),
    );
  });
} finally {
  // Only the unique directory created by this invocation is removed.
  await rm(staging, { recursive: true, force: true });
}
