import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { checkSpace, safeFile } from '../storage/files';
import type { PackageProgressReporter } from './package-progress';

export const PACKAGE_MAGIC = Buffer.from('AFFLATUS-PACKAGE\n');
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
export const MAX_DATABASE_BYTES = 128 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 1024 ** 4;
export const MAX_FILES = 10001;
const CHUNK_BYTES = 256 * 1024;

export interface PackageEntry {
  type: 'file';
  path: string;
  size: number;
  sha256: string;
}
export interface PackageManifest {
  format: 'infinite-afflatus';
  version: 1;
  entries: PackageEntry[];
}

/** Deliberately portable paths: no separators, device names, ADS or case aliases. */
export function validatePackagePath(path: unknown): asserts path is string {
  if (path === 'project.sqlite') return;
  if (
    typeof path !== 'string' ||
    !/^assets\/(videos|images|audio|text)\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,180}$/.test(
      path,
    ) ||
    path.includes('..') ||
    path.endsWith('.') ||
    /\/(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(path)
  )
    throw new Error('项目包包含无效或越界的文件路径');
}

export function validateManifest(value: unknown): PackageManifest {
  const manifest = value as PackageManifest;
  if (
    manifest?.format !== 'infinite-afflatus' ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.entries) ||
    !manifest.entries.length ||
    manifest.entries.length > MAX_FILES
  )
    throw new Error('项目包格式或版本不受支持');
  const paths = new Set<string>();
  let total = 0;
  for (const entry of manifest.entries) {
    if (
      entry?.type !== 'file' ||
      Object.keys(entry).some(
        (key) => !['type', 'path', 'size', 'sha256'].includes(key),
      ) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > 256 * 1024 ** 3 ||
      typeof entry.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    )
      throw new Error('项目包文件清单无效，不支持链接或特殊文件');
    validatePackagePath(entry.path);
    if (paths.has(entry.path.toLowerCase()))
      throw new Error('项目包包含重复文件路径');
    paths.add(entry.path.toLowerCase());
    total += entry.size;
    if (
      total > MAX_PACKAGE_BYTES ||
      (entry.path === 'project.sqlite' &&
        (entry.size < 512 || entry.size > MAX_DATABASE_BYTES))
    )
      throw new Error('项目包体积超出支持范围');
  }
  if (!paths.has('project.sqlite')) throw new Error('项目包缺少项目数据库');
  return manifest;
}

async function readExactly(
  handle: FileHandle,
  bytes: number,
  position: number,
  signal?: AbortSignal,
) {
  const buffer = Buffer.allocUnsafe(bytes);
  let offset = 0;
  while (offset < bytes) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      bytes - offset,
      position + offset,
    );
    if (!bytesRead) throw new Error('项目包不完整');
    offset += bytesRead;
  }
  return buffer;
}

async function writeAll(
  handle: FileHandle,
  data: Buffer,
  signal?: AbortSignal,
  written?: (bytes: number) => void,
) {
  let offset = 0;
  while (offset < data.length) {
    signal?.throwIfAborted();
    const { bytesWritten } = await handle.write(
      data,
      offset,
      data.length - offset,
    );
    if (!bytesWritten) throw new Error('项目包写入中断');
    offset += bytesWritten;
    written?.(bytesWritten);
  }
}

export async function readPackageHeader(
  handle: FileHandle,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const size = (await handle.stat()).size;
  if (size > MAX_PACKAGE_BYTES + MAX_MANIFEST_BYTES + 32)
    throw new Error('项目包体积超出支持范围');
  const prefix = await readExactly(handle, PACKAGE_MAGIC.length + 4, 0, signal);
  if (!prefix.subarray(0, PACKAGE_MAGIC.length).equals(PACKAGE_MAGIC))
    throw new Error('这不是 Infinite Afflatus 项目包');
  const length = prefix.readUInt32BE(PACKAGE_MAGIC.length);
  if (!length || length > MAX_MANIFEST_BYTES)
    throw new Error('项目包清单体积无效');
  const start = prefix.length + length;
  const manifest = validateManifest(
    JSON.parse(
      (await readExactly(handle, length, prefix.length, signal)).toString(
        'utf8',
      ),
    ),
  );
  if (
    start + manifest.entries.reduce((sum, entry) => sum + entry.size, 0) !==
    size
  )
    throw new Error('项目包长度与清单不符');
  return { manifest, start };
}

/** Reads at most one bounded chunk. No video is buffered as a whole. */
export async function unpackPackage(
  input: FileHandle,
  destination: string,
  create: (path: string) => Promise<FileHandle>,
  signal?: AbortSignal,
  progress?: PackageProgressReporter,
): Promise<PackageManifest> {
  const { manifest, start } = await readPackageHeader(input, signal);
  progress?.start(
    manifest.entries.reduce((sum, entry) => sum + entry.size, 0),
    manifest.entries.length,
  );
  await checkSpace(
    destination,
    manifest.entries.reduce((sum, entry) => sum + entry.size, 0),
  );
  let position = start;
  for (const entry of manifest.entries) {
    signal?.throwIfAborted();
    progress?.file(entry.path);
    const output = await create(entry.path);
    const hash = createHash('sha256');
    try {
      for (let remaining = entry.size; remaining > 0; ) {
        const chunk = await readExactly(
          input,
          Math.min(CHUNK_BYTES, remaining),
          position,
          signal,
        );
        hash.update(chunk);
        await writeAll(output, chunk, signal, (bytes) =>
          progress?.written(bytes),
        );
        position += chunk.length;
        remaining -= chunk.length;
      }
      if (hash.digest('hex') !== entry.sha256)
        throw new Error(`项目包文件校验失败：${entry.path}`);
      await output.sync();
      progress?.verified();
    } finally {
      await output.close();
    }
  }
  return manifest;
}

export async function packProject(
  output: FileHandle,
  manifest: PackageManifest,
  source: (entry: PackageEntry) => Promise<string>,
  signal?: AbortSignal,
  progress?: PackageProgressReporter,
): Promise<void> {
  validateManifest(manifest);
  progress?.start(
    manifest.entries.reduce((sum, entry) => sum + entry.size, 0),
    manifest.entries.length,
  );
  const bytes = Buffer.from(JSON.stringify(manifest));
  if (bytes.length > MAX_MANIFEST_BYTES)
    throw new Error('项目包清单体积超出支持范围');
  const prefix = Buffer.alloc(PACKAGE_MAGIC.length + 4);
  PACKAGE_MAGIC.copy(prefix);
  prefix.writeUInt32BE(bytes.length, PACKAGE_MAGIC.length);
  await writeAll(output, prefix, signal);
  await writeAll(output, bytes, signal);
  for (const entry of manifest.entries) {
    signal?.throwIfAborted();
    progress?.file(entry.path);
    const input = await open(
      await source(entry),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      signal?.throwIfAborted();
      const before = await input.stat();
      if (!before.isFile() || before.size !== entry.size)
        throw new Error('项目素材大小已改变');
      const hash = createHash('sha256');
      let size = 0;
      for await (const data of input.createReadStream({
        autoClose: false,
        highWaterMark: CHUNK_BYTES,
      })) {
        const chunk = data as Buffer;
        size += chunk.length;
        if (size > entry.size) throw new Error('项目素材正在被修改');
        hash.update(chunk);
        await writeAll(output, chunk, signal, (bytes) =>
          progress?.written(bytes),
        );
      }
      const after = await input.stat();
      if (
        size !== entry.size ||
        hash.digest('hex') !== entry.sha256 ||
        before.mtimeMs !== after.mtimeMs
      )
        throw new Error('项目素材校验失败，请等待保存完成后重试');
      progress?.verified();
    } finally {
      await input.close();
    }
  }
  signal?.throwIfAborted();
  progress?.update({ phase: 'finalizing', fileName: null });
  await output.sync();
}

export const packageSource = (directory: string) => (entry: PackageEntry) =>
  safeFile(directory, entry.path);
