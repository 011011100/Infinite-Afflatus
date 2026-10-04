import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { WorkspaceDraftRecord } from '../../shared/workspace-draft';
import { syncDirectory } from '../storage/files';
import {
  draftRecord,
  MAX_DRAFT_BYTES,
  MAX_DRAFT_FILES,
  MAX_DRAFT_STORAGE_BYTES,
} from './draft-validation';

const sameFile = (a: Stats | null, b: Stats | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs);
const optionalStat = (path: string) =>
  lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });

/** Dedicated, bounded storage. Never follows links or erases an unrecognized draft. */
export class DraftFiles<T extends { seq: number } = WorkspaceDraftRecord> {
  private identity: Stats | null = null;
  readonly directory: string;
  constructor(
    private readonly userData: string,
    private readonly format?: {
      directory: string;
      decode: (input: unknown) => T;
    },
  ) {
    this.directory = join(userData, format?.directory ?? 'workspace-drafts');
  }

  async verify() {
    if ((await realpath(this.userData)) !== resolve(this.userData))
      throw new Error('恢复草稿目录路径已变化');
    await mkdir(this.directory, { mode: 0o700 }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      },
    );
    const current = await lstat(this.directory);
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      (this.identity &&
        (this.identity.dev !== current.dev ||
          this.identity.ino !== current.ino))
    )
      throw new Error('恢复草稿目录已变化，未写入或清理文件');
    this.identity ??= current;
  }

  async entries() {
    await this.verify();
    const names = await readdir(this.directory);
    if (names.length > MAX_DRAFT_FILES)
      throw new Error('恢复草稿文件数量超出上限，请保留目录并联系支持');
    return names;
  }

  async read(name: string): Promise<T | null> {
    await this.verify();
    const path = join(this.directory, name);
    const before = await optionalStat(path);
    if (!before) return null;
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > MAX_DRAFT_BYTES
    )
      throw new Error('恢复草稿文件无效或超过 16 MB，原文件已保留');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!sameFile(before, await handle.stat()))
        throw new Error('恢复草稿正在变化');
      const value = await handle.readFile('utf8');
      if (!sameFile(before, await handle.stat()))
        throw new Error('恢复草稿正在变化');
      const decode = this.format?.decode ?? draftRecord;
      return decode(JSON.parse(value)) as T;
    } finally {
      await handle.close();
    }
  }

  async write(name: string, record: T, expected: T | null) {
    const data = JSON.stringify(record);
    const size = Buffer.byteLength(data);
    if (size > MAX_DRAFT_BYTES)
      throw new Error('镜头恢复草稿超过 16 MB，尚未建立恢复副本');
    const names = await this.entries();
    let bytes = 0;
    for (const entry of names)
      bytes += (await lstat(join(this.directory, entry))).size;
    const target = join(this.directory, name);
    const previous = await optionalStat(target);
    if (
      bytes - (previous?.size ?? 0) + size > MAX_DRAFT_STORAGE_BYTES ||
      (!names.includes(name) && names.length >= MAX_DRAFT_FILES)
    )
      throw new Error('恢复草稿空间已达上限，尚未保存新的恢复副本');
    // A corrupt or replaced target is evidence, not a place to silently start over.
    const actual = previous ? await this.read(name) : null;
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw new Error('恢复草稿在写入期间变化，原文件已保留');
    const temporary = join(this.directory, `.${randomUUID()}.part`);
    const handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    const identity = await handle.stat();
    try {
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.verify();
      if (!sameFile(previous, await optionalStat(target)))
        throw new Error('恢复草稿在写入期间变化，原文件已保留');
      await rename(temporary, target);
      await syncDirectory(this.directory);
    } finally {
      const remaining = await optionalStat(temporary);
      if (
        remaining &&
        !remaining.isSymbolicLink() &&
        remaining.dev === identity.dev &&
        remaining.ino === identity.ino
      )
        await unlink(temporary);
    }
  }

  async remove(name: string, seq: number, expected?: T) {
    await this.verify();
    const path = join(this.directory, name);
    const previous = await optionalStat(path);
    const record = await this.read(name);
    if (!record || record.seq !== seq) return false;
    if (expected && JSON.stringify(record) !== JSON.stringify(expected))
      throw new Error('恢复草稿内容在清理期间变化，文件已保留');
    await this.verify();
    const current = await optionalStat(path);
    if (
      !previous?.isFile() ||
      previous.isSymbolicLink() ||
      !sameFile(previous, current)
    )
      throw new Error('恢复草稿在清理期间变化，文件已保留');
    await unlink(path);
    await syncDirectory(this.directory);
    return true;
  }
}
