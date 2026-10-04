import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { syncDirectory } from '../storage/files';

export const BACKUP_DIRECTORY = 'app-backups';
export const RETAINED_DIRECTORY = 'app-backup-retained';
export const ANCHOR_FILE = 'app-backup-anchor.json';
export const RESTORE_FILE = 'app-backup-restore.json';
export const MAX_DATABASE_BYTES = 512 * 1024 * 1024;
export const MAX_JSON_BYTES = 32 * 1024 * 1024;
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface FileIdentity {
  dev: string;
  ino: string;
  birthtimeNs: string;
}
export interface DirectoryIdentity extends FileIdentity {
  path: string;
}

export async function info(path: string) {
  return lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
}
export function identity(stat: {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}): FileIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs),
  };
}
export function validIdentity(value: unknown): value is FileIdentity {
  const item = value as FileIdentity;
  return (
    !!item &&
    ['dev', 'ino', 'birthtimeNs'].every(
      (key) =>
        typeof item[key as keyof FileIdentity] === 'string' &&
        /^-?\d+$/.test(item[key as keyof FileIdentity]),
    )
  );
}
export function sameIdentity(a: FileIdentity, b: FileIdentity) {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}
export async function directoryIdentity(
  path: string,
): Promise<DirectoryIdentity> {
  const actual = await realpath(path);
  const stat = await lstat(path, { bigint: true });
  if (actual !== resolve(path) || stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('应用备份目录已变化或不是普通目录');
  return { path: actual, ...identity(stat) };
}
export async function verifyDirectory(expected: DirectoryIdentity) {
  const actual = await directoryIdentity(expected.path);
  if (!sameIdentity(expected, actual))
    throw new Error('应用备份所对应的目录身份已变化');
}
export async function childDirectory(parent: string, name: string) {
  await directoryIdentity(parent);
  const path = join(parent, name);
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await directoryIdentity(path);
  return path;
}

/** Bounded, identity-checked reads; never let a JSON sidecar follow a link. */
export async function readJson(path: string): Promise<unknown> {
  const before = await info(path);
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    before.size > BigInt(MAX_JSON_BYTES)
  )
    throw new Error('应用备份记录不是有效的普通文件');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await handle.stat({ bigint: true });
    if (!sameIdentity(identity(before), identity(held)))
      throw new Error('应用备份记录正在变化');
    const value = await handle.readFile('utf8');
    const after = await handle.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs)
      throw new Error('应用备份记录正在变化');
    return JSON.parse(value);
  } finally {
    await handle.close();
  }
}

/** Atomic replacement is limited to the exact sidecar read by this operation. */
export async function writeJson(
  path: string,
  value: unknown,
  expected: unknown | null,
) {
  const parent = await directoryIdentity(dirname(path));
  const previous = await info(path);
  const actual = previous ? await readJson(path) : null;
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('应用备份记录在操作期间变化，未覆盖');
  const temporary = join(parent.path, `.${randomUUID()}.part`);
  const handle = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  const owned = identity(await handle.stat({ bigint: true }));
  try {
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await verifyDirectory(parent);
    const current = await info(path);
    if (
      !!previous !== !!current ||
      (previous &&
        current &&
        (!sameIdentity(identity(previous), identity(current)) ||
          previous.size !== current.size ||
          previous.mtimeNs !== current.mtimeNs))
    )
      throw new Error('应用备份记录在发布期间变化，原文件已保留');
    await rename(temporary, path);
    await syncDirectory(parent.path);
  } finally {
    const remaining = await info(temporary);
    if (
      remaining?.isFile() &&
      !remaining.isSymbolicLink() &&
      sameIdentity(owned, identity(remaining))
    )
      await unlink(temporary);
  }
}

export async function removeJson(path: string, expected: unknown) {
  const parent = await directoryIdentity(dirname(path));
  const previous = await info(path);
  if (
    !previous ||
    JSON.stringify(await readJson(path)) !== JSON.stringify(expected)
  )
    throw new Error('应用恢复记录已变化，未清理');
  await verifyDirectory(parent);
  const current = await info(path);
  if (
    !current ||
    !sameIdentity(identity(previous), identity(current)) ||
    previous.mtimeNs !== current.mtimeNs
  )
    throw new Error('应用恢复记录正在变化，未清理');
  await unlink(path);
  await syncDirectory(parent.path);
}
