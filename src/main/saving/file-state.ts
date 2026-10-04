import { type BigIntStats, lstatSync, realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { VerifiedFileState } from '../recovery/verified-file';

export type FileIdentity = Readonly<
  Pick<BigIntStats, 'dev' | 'ino' | 'birthtimeNs'>
>;
export type FileState = VerifiedFileState;

export function sameFileIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

export function sameFileState(a: FileState, b: FileState): boolean {
  return (
    sameFileIdentity(a, b) &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

export async function ordinaryFileState(file: string): Promise<FileState> {
  const state = await lstat(file, { bigint: true });
  if (!state.isFile() || state.isSymbolicLink())
    throw new Error('文件已变化或不是普通文件，暂存副本已保留');
  return state;
}

export function ordinaryFileStateSync(file: string): FileState {
  const state = lstatSync(file, { bigint: true });
  if (!state.isFile() || state.isSymbolicLink())
    throw new Error('文件已变化或不是普通文件，暂存副本已保留');
  return state;
}

export async function directoryIdentity(path: string): Promise<FileIdentity> {
  const state = await lstat(path, { bigint: true });
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error('项目目录已变化，暂存副本已保留');
  return state;
}

export function directoryIdentitySync(path: string): FileIdentity {
  const state = lstatSync(path, { bigint: true });
  if (
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    realpathSync(path) !== resolve(path)
  )
    throw new Error('项目目录已变化，暂存副本已保留');
  return state;
}
