import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isId } from '../projects/project-service';

/** Extend this list when adding independent, durable application data. Empty setup folders are harmless. */
export const MANAGED_DATA_DIRECTORIES = [
  'app-backups',
  'app-backup-retained',
  'app-root-relocation-retained',
  'staging',
  'export-work',
  'preview-work',
  'asset-recovery',
  'workspace-drafts',
  'project-edit-drafts',
  'drafts',
  'recovery-drafts',
] as const;

export async function pathInfo(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
}

export async function requireCleanProfile(
  userData: string,
  defaultRoot: string,
): Promise<void> {
  const reject = () => {
    throw new Error(
      '应用数据库 app.sqlite 已缺失，但仍有项目或待恢复资料。请放回原应用数据库后重试；未创建新的资料库',
    );
  };
  for (const suffix of ['-journal', '-wal', '-shm']) {
    if (await pathInfo(join(userData, `app.sqlite${suffix}`))) reject();
  }
  for (const name of [
    'app-backup-anchor.json',
    'app-backup-restore.json',
    'app-root-relocation.json',
  ])
    if (await pathInfo(join(userData, name))) reject();
  const names = await readdir(userData);
  for (const name of names) {
    if (
      !(MANAGED_DATA_DIRECTORIES as readonly string[]).includes(name) &&
      !name.startsWith('.afflatus-package-')
    )
      continue;
    const path = join(userData, name);
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await readdir(path)).length
    )
      reject();
  }
  if (!(await pathInfo(defaultRoot))) return;
  for (const entry of await readdir(defaultRoot, { withFileTypes: true })) {
    if (!isId(entry.name)) continue;
    if (entry.isSymbolicLink()) reject();
    if (
      entry.isDirectory() &&
      (await pathInfo(join(defaultRoot, entry.name, 'project.sqlite')))
    )
      reject();
  }
}

/** A real write probe detects read-only mounts too; cleanup is limited to our exclusive file identity. */
export async function requireWritableDirectory(
  directory: string,
): Promise<void> {
  const name = join(directory, `.afflatus-write-check-${randomUUID()}`);
  const handle = await open(
    name,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  const identity = await handle.stat();
  try {
    await handle.writeFile('');
    await handle.sync();
  } finally {
    await handle.close();
    const current = await pathInfo(name);
    if (
      current?.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === identity.dev &&
      current.ino === identity.ino
    )
      await unlink(name);
  }
}
