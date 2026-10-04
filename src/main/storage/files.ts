import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  type FileHandle,
  link,
  lstat,
  open,
  realpath,
  statfs,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface Fingerprint {
  size: number;
  sha256: string;
  device: number;
  inode: number;
  modified: number;
}

export function inside(root: string, path: string): string {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
    throw new Error('无效的项目相对路径');
  }
  const result = resolve(root, path);
  if (!result.startsWith(`${resolve(root)}${sep}`)) throw new Error('路径越界');
  return result;
}

export function overlaps(first: string, second: string): boolean {
  const part = relative(first, second);
  return (
    !part ||
    (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part))
  );
}

/** Refuse symbolic links in every component below the already canonical root. */
export async function safeFile(root: string, path: string): Promise<string> {
  if (
    (await lstat(root)).isSymbolicLink() ||
    (await realpath(root)) !== resolve(root)
  )
    throw new Error('项目根目录不能是符号链接');
  const file = inside(root, path);
  let cursor = root;
  for (const part of relative(root, file).split(sep)) {
    cursor = resolve(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error('托管文件路径包含符号链接');
  }
  if (!(await lstat(file)).isFile()) throw new Error('托管路径不是普通文件');
  return file;
}

export async function fingerprint(
  file: string,
  signal?: AbortSignal,
): Promise<Fingerprint> {
  signal?.throwIfAborted();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('只支持普通文件');
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      signal,
    })) {
      signal?.throwIfAborted();
      hash.update(chunk);
    }
    signal?.throwIfAborted();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('文件正在被其他程序修改，请稍后重试');
    }
    return {
      size: after.size,
      sha256: hash.digest('hex'),
      device: after.dev,
      inode: after.ino,
      modified: after.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}

export function sameContent(
  a: Fingerprint,
  b: Pick<Fingerprint, 'size' | 'sha256'>,
): boolean {
  return a.size === b.size && a.sha256 === b.sha256;
}

export function sameFile(a: Fingerprint, b: Fingerprint): boolean {
  return (
    sameContent(a, b) &&
    a.device === b.device &&
    a.inode === b.inode &&
    a.modified === b.modified
  );
}

export async function durableCopy(
  source: string,
  target: string,
): Promise<Fingerprint> {
  await copyFile(source, target, constants.COPYFILE_EXCL);
  const handle = await open(target, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(resolve(target, '..'));
  return fingerprint(target);
}

/** Publish a complete asset without overwriting an existing destination. */
export async function publishCopy(
  source: string,
  target: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const temporary = `${target}.${randomUUID()}.part`;
  let identity: { dev: number; ino: number } | null = null;
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const output = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      identity = await output.stat();
      await copyInto(input, output, signal);
    } finally {
      await output.close();
    }
    // link is an atomic, no-replace publication within the same volume.
    signal?.throwIfAborted();
    try {
      await link(temporary, target);
    } catch (error) {
      if (
        !['ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
      // FAT/exFAT cannot hard-link. Exclusive copy still never overwrites user data;
      // an interrupted copy stays unregistered and retries publish under a new name.
      signal?.throwIfAborted();
      const published = await open(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await copyInto(input, published, signal);
      } finally {
        await published.close();
      }
    }
    await syncDirectory(resolve(target, '..'));
  } finally {
    await input.close();
    if (identity) {
      const current = await lstat(temporary).catch(() => null);
      if (
        current &&
        !current.isSymbolicLink() &&
        current.dev === identity.dev &&
        current.ino === identity.ino
      )
        await unlink(temporary);
    }
  }
}

async function copyInto(
  input: FileHandle,
  output: FileHandle,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  for await (const chunk of input.createReadStream({
    start: 0,
    autoClose: false,
    signal,
  })) {
    const bytes = chunk as Buffer;
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesWritten } = await output.write(
        bytes,
        offset,
        bytes.length - offset,
      );
      if (!bytesWritten) throw new Error('素材保存中断');
      offset += bytesWritten;
    }
  }
  signal?.throwIfAborted();
  await output.sync();
}

export async function syncDirectory(path: string): Promise<void> {
  // Windows does not support opening directories for fsync.
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function canonicalDirectory(path: string): Promise<string> {
  const actual = await realpath(path);
  if (!(await lstat(actual)).isDirectory()) throw new Error('请选择文件夹');
  return actual;
}

export async function checkSpace(path: string, bytes: number): Promise<void> {
  const stats = await statfs(path);
  if (stats.bavail * stats.bsize < bytes + 16 * 1024 * 1024) {
    throw new Error('磁盘剩余空间不足，请更换目录或释放空间');
  }
}

export async function localFileStream(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  if (!(await handle.stat()).isFile()) {
    await handle.close();
    throw new Error('请选择普通文件');
  }
  return handle.createReadStream();
}
