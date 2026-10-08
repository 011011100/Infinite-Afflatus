import { constants } from 'node:fs';
import { copyFile, lstat, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { verifyMediaToolBundle } from '../src/main/media/media-tool-bundle.ts';

/** The optional source is explicit, local, and never downloaded or selected automatically. */
export function parsePackagingArguments(args) {
  const [mode, ...flags] = args;
  const options = {
    mode,
    bundleDirectory: undefined,
    outputDirectory: undefined,
  };
  if (!['dir', 'local'].includes(mode)) throw usage();
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const directory = flags[index + 1];
    const key =
      flag === '--media-tools'
        ? 'bundleDirectory'
        : flag === '--output'
          ? 'outputDirectory'
          : null;
    if (!key || options[key] || !directory || !isAbsolute(directory))
      throw usage();
    options[key] = directory;
  }
  return options;
}
function usage() {
  return new Error(
    'Use pnpm package:dir or pnpm package:local [--media-tools <absolute-local-directory>] [--output <new-absolute-output-directory>]; publishing and signing are disabled',
  );
}

/** The caller owns the unique staging parent; failure never deletes supplied files. */
export async function stageMediaToolBundle(source, destination, target) {
  const original = verifyMediaToolBundle(source, target);
  await mkdir(destination); // Must be a new, owned child, never reuse a user directory.
  for (const file of original.files) {
    const from = join(source, file);
    const info = await lstat(from);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`Media tool bundle changed while staging: ${file}`);
    const to = join(destination, file);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to, constants.COPYFILE_EXCL);
  }
  const staged = verifyMediaToolBundle(destination, target);
  if (JSON.stringify(staged.manifest) !== JSON.stringify(original.manifest))
    throw new Error('Media tool bundle manifest changed while staging');
  // Source mutation and newly added undeclared files also fail this invocation closed.
  const after = verifyMediaToolBundle(source, target);
  if (JSON.stringify(after.manifest) !== JSON.stringify(original.manifest))
    throw new Error('Media tool bundle source changed while staging');
  return staged;
}
