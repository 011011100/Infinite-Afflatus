import type { BigIntStats } from 'node:fs';
import { type FileHandle, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { AppStore } from '../storage/app-store';

export interface FileIdentity {
  dev: string;
  ino: string;
  birthtimeNs: string;
}

export interface PartFingerprint extends FileIdentity {
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

export interface PartOwnership {
  version: 1;
  jobId: string;
  directory: string;
  directoryIdentity: FileIdentity;
  fileIdentity: FileIdentity;
  sealedFingerprint?: PartFingerprint;
  partialSha256?: string;
  cleanup?: { job: string; fingerprint: PartFingerprint };
}

const KEY = 'stagingPartOwnership';
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const integer = (value: unknown): value is string =>
  typeof value === 'string' && /^-?\d{1,40}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function validIdentity(value: unknown): value is FileIdentity {
  return (
    object(value) &&
    integer(value.dev) &&
    integer(value.ino) &&
    integer(value.birthtimeNs)
  );
}
function validFingerprint(value: unknown): value is PartFingerprint {
  return (
    validIdentity(value) &&
    object(value) &&
    integer(value.size) &&
    integer(value.mtimeNs) &&
    integer(value.ctimeNs)
  );
}

export function identity(info: BigIntStats): FileIdentity {
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeNs: String(info.birthtimeNs),
  };
}
export function partFingerprint(info: BigIntStats): PartFingerprint {
  return {
    ...identity(info),
    size: String(info.size),
    mtimeNs: String(info.mtimeNs),
    ctimeNs: String(info.ctimeNs),
  };
}
export function sameIdentity(
  first: FileIdentity,
  second: FileIdentity,
): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.birthtimeNs === second.birthtimeNs
  );
}
export function samePart(
  first: PartFingerprint,
  second: PartFingerprint,
): boolean {
  return (
    sameIdentity(first, second) &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}

/** Only a file created by this process may acquire ownership; never adopt old paths. */
export class StagingOwnership {
  constructor(
    readonly directory: string,
    private readonly store: AppStore,
  ) {}

  private records(): PartOwnership[] {
    const value = this.store.get<unknown>(KEY);
    if (value === null && !this.store.hasSetting(KEY)) return [];
    if (!object(value) || value.version !== 1 || !Array.isArray(value.entries))
      throw new Error('暂存归属记录不受支持，原文件已保留');
    const seen = new Set<string>();
    for (const entry of value.entries) {
      if (
        !object(entry) ||
        entry.version !== 1 ||
        typeof entry.jobId !== 'string' ||
        !UUID.test(entry.jobId) ||
        seen.has(entry.jobId) ||
        typeof entry.directory !== 'string' ||
        !isAbsolute(entry.directory) ||
        entry.directory.includes('\0') ||
        !validIdentity(entry.directoryIdentity) ||
        !validIdentity(entry.fileIdentity) ||
        (entry.sealedFingerprint !== undefined &&
          (!validFingerprint(entry.sealedFingerprint) ||
            !sameIdentity(entry.fileIdentity, entry.sealedFingerprint))) ||
        ((entry.sealedFingerprint !== undefined ||
          entry.partialSha256 !== undefined) &&
          (!validFingerprint(entry.sealedFingerprint) ||
            typeof entry.partialSha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(entry.partialSha256))) ||
        (entry.cleanup !== undefined &&
          (!object(entry.cleanup) ||
            typeof entry.cleanup.job !== 'string' ||
            !validFingerprint(entry.cleanup.fingerprint)))
      )
        throw new Error('暂存归属记录已损坏，原文件已保留');
      seen.add(entry.jobId);
    }
    return value.entries as PartOwnership[];
  }

  get(id: string): PartOwnership | null {
    return this.records().find((entry) => entry.jobId === id) ?? null;
  }

  list(): PartOwnership[] {
    return this.records();
  }

  async directoryIdentity(): Promise<FileIdentity> {
    const info = await lstat(this.directory, { bigint: true });
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(this.directory)) !== resolve(this.directory)
    )
      throw new Error('暂存目录已变化或包含符号链接，原文件已保留');
    return identity(info);
  }

  async registerCreated(
    id: string,
    file: FileHandle,
    directoryIdentity: FileIdentity,
  ): Promise<void> {
    if (!UUID.test(id)) throw new Error('无效的暂存任务');
    const info = await file.stat({ bigint: true });
    const named = await lstat(join(this.directory, `${id}.part`), {
      bigint: true,
    });
    if (
      !info.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      !sameIdentity(identity(info), identity(named)) ||
      !sameIdentity(directoryIdentity, await this.directoryIdentity())
    )
      throw new Error('暂存文件在登记前已变化，未认领文件');
    const entries = this.records();
    if (entries.some((entry) => entry.jobId === id))
      throw new Error('暂存任务已有归属记录');
    entries.push({
      version: 1,
      jobId: id,
      directory: resolve(this.directory),
      directoryIdentity,
      fileIdentity: identity(info),
    });
    this.store.set(KEY, { version: 1, entries });
  }

  async verifyDirectory(entry: PartOwnership): Promise<void> {
    if (
      entry.directory !== resolve(this.directory) ||
      !sameIdentity(entry.directoryIdentity, await this.directoryIdentity())
    )
      throw new Error('暂存目录与创建记录不匹配，原文件已保留');
  }

  async sealIncomplete(
    id: string,
    file: FileHandle,
    writtenBytes: number,
    partialSha256: string,
  ): Promise<void> {
    const entry = this.get(id);
    if (!entry) throw new Error('未登记的暂存文件不能补认领');
    await this.verifyDirectory(entry);
    const info = await file.stat({ bigint: true });
    const named = await lstat(join(this.directory, `${id}.part`), {
      bigint: true,
    });
    const sealed = partFingerprint(info);
    if (
      !info.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      !sameIdentity(entry.fileIdentity, sealed) ||
      !samePart(sealed, partFingerprint(named)) ||
      info.size !== BigInt(writtenBytes)
    )
      throw new Error('暂存文件在接收结束前已变化，未登记清理依据');
    this.replace(entry, { ...entry, sealedFingerprint: sealed, partialSha256 });
  }

  markCleanup(
    entry: PartOwnership,
    job: string,
    fingerprint: PartFingerprint,
  ): PartOwnership {
    const next: PartOwnership = { ...entry, cleanup: { job, fingerprint } };
    this.replace(entry, next);
    return next;
  }

  forget(entry: PartOwnership): void {
    this.replace(entry, null);
  }

  private replace(expected: PartOwnership, next: PartOwnership | null): void {
    const entries = this.records();
    const index = entries.findIndex((entry) => entry.jobId === expected.jobId);
    if (
      index < 0 ||
      JSON.stringify(entries[index]) !== JSON.stringify(expected)
    )
      throw new Error('暂存归属记录已变化，请重新检查');
    if (next) entries[index] = next;
    else entries.splice(index, 1);
    this.store.set(KEY, { version: 1, entries });
  }
}
