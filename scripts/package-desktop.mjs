import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stageApplication } from './package-content.mjs';
import {
  parsePackagingArguments,
  stageMediaToolBundle,
} from './package-media-tools.mjs';

const { mode, bundleDirectory, outputDirectory } = parsePackagingArguments(
  process.argv.slice(2),
);
if (!['darwin', 'win32'].includes(process.platform))
  throw new Error(
    'Internal packaging currently supports native macOS and Windows builders',
  );
const root = fileURLToPath(new URL('../', import.meta.url));
const release = outputDirectory ?? join(root, 'release');
if (outputDirectory) {
  await mkdir(dirname(release), { recursive: true });
  // An explicit output belongs only to this invocation; never reuse or clean another run.
  await mkdir(release);
} else await mkdir(release, { recursive: true });
const staging = await mkdtemp(join(release, '.app-staging-'));
const require = createRequire(import.meta.url);
try {
  const appStaging = join(staging, 'app');
  await stageApplication(root, appStaging);
  const bundleStaging = bundleDirectory ? join(staging, 'media-tools') : null;
  const bundle = bundleStaging
    ? await stageMediaToolBundle(bundleDirectory, bundleStaging, {
        platform: process.platform,
        arch: process.arch,
      })
    : null;
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
  // Never inherit an unrelated optional bundle from the caller's environment.
  delete env.AFFLATUS_MEDIA_TOOLS_STAGING;
  delete env.AFFLATUS_MEDIA_TOOLS_MANIFEST;
  if (bundleStaging && bundle) {
    env.AFFLATUS_MEDIA_TOOLS_STAGING = bundleStaging;
    env.AFFLATUS_MEDIA_TOOLS_MANIFEST = JSON.stringify(bundle.manifest);
  }
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  const args = [
    '--import',
    pathToFileURL(require.resolve('tsx')).href,
    require.resolve('electron-builder/cli.js'),
    '--config',
    join(root, 'electron-builder.config.cjs'),
    `-c.directories.app=${appStaging}`,
    `-c.directories.output=${release}`,
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
