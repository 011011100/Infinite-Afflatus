import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { decodeRescue } from './rescue-record';

export const MAX_RESCUE_SOURCE_BYTES = 64 * 1024 * 1024;

export function rescueFileIdentity(stat: BigIntStats) {
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.birthtimeNs,
  ]
    .map(String)
    .join(':');
}

export async function canonicalRescuePath(path: string): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0'))
    throw new Error('请选择有效的救援文件绝对路径');
  const normalized = resolve(path);
  let current = normalized;
  while (true) {
    const stat = await lstat(current);
    if (
      stat.isSymbolicLink() ||
      (current !== normalized && !stat.isDirectory())
    )
      throw new Error('救援文件或其目录不能是符号链接');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const canonical = await realpath(normalized);
  const comparable = (value: string) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  if (comparable(canonical) !== comparable(normalized))
    throw new Error('救援文件路径已变化或包含符号链接');
  return canonical;
}

/** Read-only, bounded and checked on both sides of the open handle and pathname. */
export async function readRescueSource(
  path: string,
  check: () => void = () => {},
) {
  check();
  const canonical = await canonicalRescuePath(path);
  const before = await lstat(canonical, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > BigInt(MAX_RESCUE_SOURCE_BYTES)
  )
    throw new Error('救援文件必须是普通文件，且不能超过 64 MiB');
  const identity = rescueFileIdentity(before);
  const handle = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const pieces: Buffer[] = [];
  const hash = createHash('sha256');
  let size = 0;
  try {
    if (rescueFileIdentity(await handle.stat({ bigint: true })) !== identity)
      throw new Error('救援文件在读取前已变化，请重新检查');
    while (true) {
      check();
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, size);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_RESCUE_SOURCE_BYTES)
        throw new Error('救援文件超过 64 MiB');
      const bytes = chunk.subarray(0, bytesRead);
      pieces.push(bytes);
      hash.update(bytes);
    }
    if (rescueFileIdentity(await handle.stat({ bigint: true })) !== identity)
      throw new Error('救援文件在读取期间已变化，请重新检查');
  } finally {
    await handle.close();
  }
  check();
  if (
    (await canonicalRescuePath(path)) !== canonical ||
    rescueFileIdentity(await lstat(canonical, { bigint: true })) !== identity
  )
    throw new Error('救援文件在读取期间被替换，请重新检查');
  // Accept a UTF-8 BOM, but never silently replace corrupt authored characters.
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(pieces, size),
      ),
    );
  } catch (cause) {
    throw new Error('恢复文件内容损坏或文本编码无效，原文件已保留', { cause });
  }
  const record = decodeRescue(value);
  return {
    path: canonical,
    identity,
    digest: hash.digest('hex'),
    size,
    record,
  };
}

/** Do not hash whole videos: this confirms current registered bytes are accessible, not historical provenance. */
export async function inspectRescueMedia(path: string, expectedSize: number) {
  const canonical = await canonicalRescuePath(path);
  const stat = await lstat(canonical, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size !== BigInt(expectedSize)
  )
    throw new Error('引用素材缺失或文件大小已变化，请先修复原项目素材');
  const identity = rescueFileIdentity(stat);
  const handle = await open(
    canonical,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    if (rescueFileIdentity(await handle.stat({ bigint: true })) !== identity)
      throw new Error('引用素材在检查期间变化');
  } finally {
    await handle.close();
  }
  if (
    (await canonicalRescuePath(path)) !== canonical ||
    rescueFileIdentity(await lstat(canonical, { bigint: true })) !== identity
  )
    throw new Error('引用素材在检查期间被替换');
  return { path: canonical, identity };
}
