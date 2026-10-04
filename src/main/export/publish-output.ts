import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { AppStore } from '../storage/app-store';
import {
  canonicalDirectory,
  checkSpace,
  fingerprint,
  localFileStream,
  overlaps,
  sameContent,
  syncDirectory,
} from '../storage/files';

interface PendingOutput {
  file: string;
  device: number;
  inode: number;
}

export async function validateOutputPath(
  path: string,
  projectRoot: string,
  userData: string,
): Promise<string> {
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    !path.toLowerCase().endsWith('.mp4')
  )
    throw new Error('请选择 MP4 输出文件');
  const parent = await canonicalDirectory(dirname(path));
  const output = join(parent, basename(path));
  if (overlaps(projectRoot, output) || overlaps(userData, output))
    throw new Error('请将成片保存到项目库和应用数据目录之外');
  const current = await lstat(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (current) throw new Error('输出文件已存在，请使用新的文件名');
  return output;
}

export async function cleanPendingOutput(store: AppStore): Promise<void> {
  const kept: PendingOutput[] = [];
  for (const record of store.get<PendingOutput[]>('exportPendingOutputs') ??
    []) {
    try {
      // An offline external disk or replaced parent must not prevent library startup.
      if (
        (await realpath(dirname(record.file))) !== resolve(dirname(record.file))
      ) {
        kept.push(record);
        continue;
      }
    } catch {
      kept.push(record);
      continue;
    }
    try {
      const stat = await lstat(record.file);
      if (
        !stat.isSymbolicLink() &&
        stat.dev === record.device &&
        stat.ino === record.inode
      )
        await unlink(record.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') kept.push(record);
    }
  }
  store.set('exportPendingOutputs', kept);
}

/** Write beside the destination and publish atomically without ever replacing existing data. */
export async function publishOutput(
  source: string,
  target: string,
  store: AppStore,
  signal: AbortSignal,
): Promise<void> {
  const sourceFingerprint = await fingerprint(source);
  await checkSpace(dirname(target), sourceFingerprint.size);
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${randomUUID()}.part`,
  );
  const handle = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    const stat = await handle.stat();
    store.set('exportPendingOutputs', [
      ...(store.get<PendingOutput[]>('exportPendingOutputs') ?? []),
      {
        file: temporary,
        device: stat.dev,
        inode: stat.ino,
      },
    ]);
  } finally {
    await handle.close();
  }
  try {
    await pipeline(
      await localFileStream(source),
      createWriteStream(temporary, { flags: 'r+' }),
      { signal },
    );
    const written = await open(
      temporary,
      constants.O_RDWR | constants.O_NOFOLLOW,
    );
    try {
      await written.sync();
    } finally {
      await written.close();
    }
    if (!sameContent(sourceFingerprint, await fingerprint(temporary)))
      throw new Error('成片保存校验失败');
    signal.throwIfAborted();
    // A hard link is the portable Node operation that is atomic AND refuses replacement.
    // Unsupported filesystems fail safely instead of exposing a partial .mp4 after a crash.
    try {
      await link(temporary, target);
    } catch (error) {
      if (
        ['ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw new Error('此磁盘不支持安全发布文件，请先导出到本机磁盘后再复制');
      throw error;
    }
    await syncDirectory(dirname(target));
  } finally {
    await cleanPendingOutput(store);
  }
}
