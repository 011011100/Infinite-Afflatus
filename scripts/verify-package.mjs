import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage, statFile, uncache } from '@electron/asar';
import {
  MEDIA_TOOL_BUNDLE_DIRECTORY,
  verifyMediaToolBundle,
} from '../src/main/media/media-tool-bundle.ts';
import { APP_NAME, checkApplicationFiles } from './package-content.mjs';

export function verifyAsar(
  archive,
  reader = { listPackage, statFile, extractFile },
) {
  // ASAR caches headers by filename; a repeated validation must read current bytes.
  uncache(archive);
  const files = [];
  const nativePaths = new Map();
  for (const path of reader.listPackage(archive)) {
    // ASAR's tree lookup splits path.sep; keep native paths for every library call.
    const nativePath = path.replace(/^[\\/]/, '');
    const file = nativePath.replaceAll('\\', '/');
    const info = reader.statFile(archive, nativePath, false);
    if ('link' in info || info.unpacked)
      throw new Error(
        `Unexpected linked or unpacked application entry: ${file}`,
      );
    if (!('files' in info)) {
      files.push(file);
      nativePaths.set(file, nativePath);
    }
  }
  checkApplicationFiles(files, (file) =>
    reader.extractFile(archive, nativePaths.get(file)).toString('utf8'),
  );
  return { asar: archive, files: files.length };
}

export async function verifyPackagedApp(
  appOutDir,
  {
    platform = process.platform,
    arch = process.arch,
    productName = APP_NAME,
    requireMediaTools = false,
    expectedMediaToolManifest,
  } = {},
) {
  const resources =
    platform === 'darwin'
      ? join(appOutDir, `${productName}.app`, 'Contents', 'Resources')
      : join(appOutDir, 'resources');
  const unpacked = await lstat(join(resources, 'app.asar.unpacked')).catch(
    (error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    },
  );
  if (unpacked)
    throw new Error('This application must not contain unpacked dependencies');
  const application = verifyAsar(join(resources, 'app.asar'));
  const directory = join(resources, MEDIA_TOOL_BUNDLE_DIRECTORY);
  const bundle = await lstat(directory).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!bundle) {
    if (requireMediaTools || expectedMediaToolManifest)
      throw new Error('Expected packaged media tool bundle is missing');
    return application;
  }
  const verified = verifyMediaToolBundle(directory, { platform, arch });
  if (
    expectedMediaToolManifest &&
    JSON.stringify(verified.manifest) !==
      JSON.stringify(expectedMediaToolManifest)
  )
    throw new Error(
      'Packaged media tool bundle differs from the verified supplied manifest',
    );
  return {
    ...application,
    mediaTools: {
      directory,
      manifest: verified.manifest,
      files: verified.files.length,
    },
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const path = process.argv[2];
  if (!path)
    throw new Error(
      'Usage: node scripts/verify-package.mjs <unpacked-directory>',
    );
  console.log(JSON.stringify(await verifyPackagedApp(resolve(path)), null, 2));
}
