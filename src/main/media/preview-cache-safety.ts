import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { type Fingerprint, fingerprint, inside } from '../storage/files';

export interface FileFacts {
  device: number;
  inode: number;
  size: number;
  modified: number;
  changed: number;
  links: number;
}
export interface PathFacts {
  file: string;
  directories: { path: string; device: number; inode: number }[];
  facts: FileFacts;
}
export interface VerifiedFile extends PathFacts {
  content: Fingerprint;
}

function fileFacts(info: Stats): FileFacts {
  return {
    device: info.dev,
    inode: info.ino,
    size: info.size,
    modified: info.mtimeMs,
    changed: info.ctimeMs,
    links: info.nlink,
  };
}

/** Synchronous final path checks leave no renderer/encoder admission between check and unlink. */
export function pathFacts(root: string, path: string): PathFacts {
  if (realpathSync(root) !== resolve(root))
    throw new Error('目录路径包含符号链接，已保留');
  const file = inside(root, path);
  const directories: PathFacts['directories'] = [];
  let cursor = root;
  const parts = relative(root, dirname(file)).split(sep).filter(Boolean);
  for (const part of ['', ...parts]) {
    if (part) cursor = resolve(cursor, part);
    const info = lstatSync(cursor);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error('目录已变化或包含符号链接，已保留');
    directories.push({ path: cursor, device: info.dev, inode: info.ino });
  }
  const info = lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error('路径不是普通文件或包含符号链接，已保留');
  if (!Number.isSafeInteger(info.size))
    throw new Error('文件大小无法安全表示，已保留');
  return { file, directories, facts: fileFacts(info) };
}

export function samePath(a: PathFacts, b: PathFacts): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function unchangedPath(
  root: string,
  path: string,
  expected: PathFacts,
): void {
  if (
    !samePath(pathFacts(root, path), {
      file: expected.file,
      directories: expected.directories,
      facts: expected.facts,
    })
  )
    throw new Error('文件或上级目录在检查后已变化，已保留');
}

export async function verifiedFile(
  root: string,
  path: string,
  signal: AbortSignal,
): Promise<VerifiedFile> {
  signal.throwIfAborted();
  const before = pathFacts(root, path);
  if (before.facts.links !== 1)
    throw new Error('文件有多个硬链接，无法确认独立归属，已保留');
  const content = await fingerprint(before.file, signal);
  unchangedPath(root, path, before);
  if (
    content.device !== before.facts.device ||
    content.inode !== before.facts.inode ||
    content.size !== before.facts.size ||
    content.modified !== before.facts.modified
  )
    throw new Error('文件在校验期间已变化，已保留');
  return { ...before, content };
}
