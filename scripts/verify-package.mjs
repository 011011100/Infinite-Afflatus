import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage, statFile } from '@electron/asar';
import { APP_NAME, checkApplicationFiles } from './package-content.mjs';

export function verifyAsar(archive) {
  const files = [];
  for (const path of listPackage(archive)) {
    // ASAR lists native paths: Windows entries start with \\ and use \\ separators.
    const file = path.replaceAll('\\', '/').replace(/^\//, '');
    const info = statFile(archive, file, false);
    if ('link' in info || info.unpacked)
      throw new Error(
        `Unexpected linked or unpacked application entry: ${file}`,
      );
    if (!('files' in info)) files.push(file);
  }
  checkApplicationFiles(files, (file) =>
    extractFile(archive, file).toString('utf8'),
  );
  return { asar: archive, files: files.length };
}

export async function verifyPackagedApp(
  appOutDir,
  { platform = process.platform, productName = APP_NAME } = {},
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
  return verifyAsar(join(resources, 'app.asar'));
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
