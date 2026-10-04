import { constants, lstatSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  directoryIdentity,
  identity,
  info,
  MAX_DATABASE_BYTES,
  verifyDirectory,
} from '../backups/backup-files';
import { verifyFile } from '../recovery/verified-file';
import { ordinaryFileState, sameFileState } from '../saving/file-state';
import type { DatabaseEvidence } from './root-relocation-types';

export const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Bind the digest to the opened descriptor, including ctime and bounded reads. */
export async function databaseEvidence(
  path: string,
  signal = new AbortController().signal,
): Promise<DatabaseEvidence | null> {
  return (await databaseProof(path, signal))?.evidence ?? null;
}
export async function databaseProof(
  path: string,
  signal = new AbortController().signal,
) {
  if (!(await info(path))) return null;
  const parent = await directoryIdentity(dirname(path));
  const before = await ordinaryFileState(path);
  if (before.size > BigInt(MAX_DATABASE_BYTES))
    throw new Error('应用或项目数据库过大，未自动重新定位');
  const result = await verifyFile(path, Number(before.size), signal, () => {});
  await verifyDirectory(parent);
  if (
    !sameFileState(before, result.state) ||
    !sameFileState(before, await ordinaryFileState(path))
  )
    throw new Error('数据库在检查期间变化，请重新检查');
  return {
    state: before,
    evidence: {
      ...identity(before),
      size: String(before.size),
      mtimeNs: String(before.mtimeNs),
      sha256: result.sha256,
    } satisfies DatabaseEvidence,
  };
}

export async function requireDatabase(path: string, signal?: AbortSignal) {
  const evidence = await databaseEvidence(path, signal);
  if (!evidence) throw new Error('应用或项目数据库缺失，未重新定位');
  return evidence;
}

/** This first version accepts only self-contained DELETE-journal databases. */
export async function requireIndependentDatabase(path: string) {
  for (const suffix of ['-wal', '-shm', '-journal'])
    if (await info(`${path}${suffix}`))
      throw new Error(
        '数据库仍有未决日志，已保留原文件，请先恢复原位置后关闭应用',
      );
  const selected = await ordinaryFileState(path);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!sameFileState(selected, await handle.stat({ bigint: true })))
      throw new Error('数据库在打开时变化');
    const header = Buffer.alloc(100);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead !== 100 ||
      header.subarray(0, 16).toString() !== 'SQLite format 3\0' ||
      header[18] !== 1 ||
      header[19] !== 1
    )
      throw new Error('数据库不是独立的 SQLite 快照，未修改原文件');
    if (
      !sameFileState(selected, await handle.stat({ bigint: true })) ||
      !sameFileState(selected, await ordinaryFileState(path))
    )
      throw new Error('数据库在检查期间变化');
  } finally {
    await handle.close();
  }
}

export function assertFileEvidence(path: string, evidence: DatabaseEvidence) {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    !same(
      {
        ...identity(stat),
        size: String(stat.size),
        mtimeNs: String(stat.mtimeNs),
        sha256: evidence.sha256,
      },
      evidence,
    )
  )
    throw new Error('数据库身份在打开时变化');
}
