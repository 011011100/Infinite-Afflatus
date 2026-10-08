import { createHash } from 'node:crypto';
import {
  accessSync,
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type {
  MediaToolBundleFile,
  MediaToolBundleManifest,
} from '../../shared/media-tool-bundle';
import type {
  MediaToolLocation,
  MediaToolName,
} from '../../shared/media-tools';

export const MEDIA_TOOL_BUNDLE_DIRECTORY = 'media-tools';
export const MEDIA_TOOL_BUNDLE_MANIFEST = 'manifest.json';
export interface MediaToolBundleTarget {
  platform?: NodeJS.Platform;
  arch?: string;
}
export interface VerifiedMediaToolBundle {
  directory: string;
  manifest: MediaToolBundleManifest;
  /** Only these files, including the manifest itself, may be staged. */
  files: string[];
  commands: { ffmpeg: string; ffprobe: string };
}
export type MediaToolBundleState =
  | { status: 'absent' }
  | { status: 'invalid'; directory: string; error: string }
  | { status: 'verified'; bundle: VerifiedMediaToolBundle };
type Fingerprint = ReturnType<typeof identity>;
type HashCache = Map<string, { identity: Fingerprint; sha256: string }>;
interface BundleProof {
  directory: string;
  target: Required<MediaToolBundleTarget>;
  signature: string;
  commands: Readonly<Record<MediaToolName, string>>;
  hashes: HashCache;
}
// Neither IPC serialization nor a source label can manufacture launch authority.
const bundleProofs = new WeakMap<VerifiedMediaToolBundle, BundleProof>();
const locationProofs = new WeakMap<MediaToolLocation, BundleProof>();

function invalid(detail: string): never {
  throw new Error(`Invalid media tool bundle: ${detail}`);
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid('expected a manifest object');
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return invalid(`unsupported manifest fields (expected ${keys.join(', ')})`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 2048 ||
    Array.from(value).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    return invalid(`missing or invalid ${label}`);
  return value;
}
function declaration(value: unknown): MediaToolBundleFile {
  const row = record(value, ['file', 'sha256']);
  const file = text(row.file, 'relative filename');
  if (
    file.length > 512 ||
    file.split('/').length > 8 ||
    file
      .split('/')
      .some(
        (part) =>
          !part ||
          part.startsWith('.') ||
          /[\\:<>"|?*]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      ) ||
    typeof row.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.sha256)
  )
    return invalid(`unsafe filename or invalid SHA-256: ${file}`);
  return { file, sha256: row.sha256 };
}
export function parseMediaToolBundleManifest(
  value: unknown,
  target: MediaToolBundleTarget = {},
): MediaToolBundleManifest {
  const row = record(value, [
    'version',
    'target',
    'build',
    'license',
    'tools',
    'notices',
  ]);
  if (row.version !== 1) return invalid('unsupported manifest version');
  const platform = target.platform ?? process.platform;
  const arch = target.arch ?? process.arch;
  const manifestTarget = record(row.target, ['platform', 'arch']);
  if (
    !['darwin', 'win32'].includes(platform) ||
    !['x64', 'arm64'].includes(arch) ||
    manifestTarget.platform !== platform ||
    manifestTarget.arch !== arch
  )
    return invalid(`unsupported or mismatched target ${platform}/${arch}`);
  const build = record(row.build, ['version', 'source']);
  const tools = record(row.tools, ['ffmpeg', 'ffprobe']);
  if (
    !Array.isArray(row.notices) ||
    !row.notices.length ||
    row.notices.length > 32
  )
    return invalid(
      'at least one declared notice/license file is required (maximum 32)',
    );
  const manifest: MediaToolBundleManifest = {
    version: 1,
    target: {
      platform: platform as 'darwin' | 'win32',
      arch: arch as 'x64' | 'arm64',
    },
    build: {
      version: text(build.version, 'build version'),
      source: text(build.source, 'build source URL or reference'),
    },
    license: text(row.license, 'license identifier'),
    tools: {
      ffmpeg: declaration(tools.ffmpeg),
      ffprobe: declaration(tools.ffprobe),
    },
    notices: row.notices.map(declaration),
  };
  const paths = [
    MEDIA_TOOL_BUNDLE_MANIFEST,
    manifest.tools.ffmpeg.file,
    manifest.tools.ffprobe.file,
    ...manifest.notices.map((notice) => notice.file),
  ].map((file) => file.toLowerCase());
  if (
    new Set(paths).size !== paths.length ||
    paths.some((file) => paths.some((other) => other.startsWith(`${file}/`)))
  )
    return invalid('duplicate or conflicting filenames');
  return manifest;
}
function identity(info: BigIntStats): string {
  return [
    info.dev,
    info.ino,
    info.mode,
    info.size,
    info.mtimeNs,
    info.ctimeNs,
  ].join(':');
}
function regular(path: string) {
  const info = lstatSync(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || !info.size)
    return invalid(`not a nonempty regular file: ${path}`);
  return info;
}
function readVerifiedFile(path: string, collect = false) {
  const before = regular(path);
  if (collect && before.size > 64 * 1024)
    return invalid('manifest exceeds 64 KiB');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || identity(before) !== identity(opened))
      return invalid(`file changed during verification: ${path}`);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      const size = readSync(fd, buffer);
      if (!size) break;
      length += size;
      if (collect && length > 64 * 1024)
        return invalid('manifest exceeds 64 KiB');
      hash.update(buffer.subarray(0, size));
      if (collect) chunks.push(Buffer.from(buffer.subarray(0, size)));
    }
    if (
      identity(before) !== identity(fstatSync(fd, { bigint: true })) ||
      identity(before) !== identity(regular(path))
    )
      return invalid(`file changed during verification: ${path}`);
    return {
      identity: identity(before),
      sha256: hash.digest('hex'),
      contents: collect ? Buffer.concat(chunks).toString('utf8') : '',
    };
  } finally {
    closeSync(fd);
  }
}

/** Verifies bytes and declared provenance, never runs tools or grants redistribution rights. */
export function verifyMediaToolBundle(
  directory: string,
  target: MediaToolBundleTarget = {},
): VerifiedMediaToolBundle {
  return verifyBundle(directory, target, new Map());
}
function verifyBundle(
  directory: string,
  target: MediaToolBundleTarget,
  cache: HashCache,
): VerifiedMediaToolBundle {
  if (!isAbsolute(directory))
    return invalid('bundle directory must be absolute');
  const root = lstatSync(directory, { bigint: true });
  if (!root.isDirectory() || root.isSymbolicLink())
    return invalid(
      'bundle root must be a regular directory, not a symbolic link',
    );
  const manifestFile = join(directory, MEDIA_TOOL_BUNDLE_MANIFEST);
  const manifestRead = readVerifiedFile(manifestFile, true);
  const manifest = parseMediaToolBundleManifest(
    JSON.parse(manifestRead.contents),
    target,
  );
  const declared = [
    manifest.tools.ffmpeg,
    manifest.tools.ffprobe,
    ...manifest.notices,
  ];
  const files = [
    MEDIA_TOOL_BUNDLE_MANIFEST,
    ...declared.map(({ file }) => file),
  ].sort();
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    while (parts.pop() && parts.length) directories.add(parts.join('/'));
  }
  const actual = new Map<string, string>();
  function visit(relative: string) {
    for (const entry of readdirSync(join(directory, relative))) {
      const file = relative ? `${relative}/${entry}` : entry;
      const info = lstatSync(join(directory, file), { bigint: true });
      if (info.isSymbolicLink()) return invalid(`symbolic link: ${file}`);
      if (info.isDirectory() && directories.has(file)) {
        actual.set(file, identity(info));
        visit(file);
      } else if (info.isFile() && files.includes(file))
        actual.set(file, identity(info));
      else return invalid(`undeclared or unsupported entry: ${file}`);
    }
  }
  visit('');
  for (const { file, sha256 } of declared) {
    const path = join(directory, file);
    const info = actual.get(file);
    if (!info) return invalid(`missing declared file: ${file}`);
    let digest = cache.get(path);
    if (!digest || digest.identity !== info) {
      digest = readVerifiedFile(path);
      cache.set(path, { identity: digest.identity, sha256: digest.sha256 });
    }
    if (digest.sha256 !== sha256) return invalid(`SHA-256 mismatch: ${file}`);
  }
  if (manifest.target.platform !== 'win32') {
    accessSync(join(directory, manifest.tools.ffmpeg.file), constants.X_OK);
    accessSync(join(directory, manifest.tools.ffprobe.file), constants.X_OK);
  }
  const first = JSON.stringify([...actual].sort());
  actual.clear();
  visit('');
  if (
    identity(root) !== identity(lstatSync(directory, { bigint: true })) ||
    manifestRead.identity !== identity(regular(manifestFile)) ||
    first !== JSON.stringify([...actual].sort())
  )
    return invalid('bundle changed during verification');
  const bundle: VerifiedMediaToolBundle = {
    directory,
    manifest,
    files,
    commands: {
      ffmpeg: join(directory, manifest.tools.ffmpeg.file),
      ffprobe: join(directory, manifest.tools.ffprobe.file),
    },
  };
  bundleProofs.set(bundle, {
    directory,
    target: { ...manifest.target },
    signature: createHash('sha256')
      .update(JSON.stringify([identity(root), first, manifestRead.sha256]))
      .digest('hex'),
    commands: Object.freeze({ ...bundle.commands }),
    hashes: new Map([...cache].map(([path, digest]) => [path, { ...digest }])),
  });
  return bundle;
}

/** Keep the exact verified proof on the same frozen object retained by each task. */
export function bundledMediaToolLocation(
  bundle: VerifiedMediaToolBundle,
  name: MediaToolName,
): Readonly<MediaToolLocation> {
  const proof = bundleProofs.get(bundle);
  if (!proof)
    return invalid('bundled location requires an original verification proof');
  const location: MediaToolLocation = Object.freeze({
    name,
    command: proof.commands[name],
    source: 'bundled',
  });
  locationProofs.set(location, proof);
  return location;
}

/** Called synchronously immediately before every spawn, after any awaited preparation. */
export function assertMediaToolLaunch(location: MediaToolLocation): void {
  if (location.unavailableReason) throw new Error(location.unavailableReason);
  if (location.source !== 'bundled') return;
  try {
    const captured = locationProofs.get(location);
    if (!captured || captured.commands[location.name] !== location.command)
      invalid('missing original bundled tool verification proof');
    const current = verifyBundle(
      captured.directory,
      captured.target,
      new Map(captured.hashes),
    );
    if (bundleProofs.get(current)?.signature !== captured.signature)
      invalid(
        'bundled tool or manifest changed after this task captured its tools',
      );
  } catch (error) {
    throw new Error(
      `内置视频处理组件校验失败：${error instanceof Error ? error.message : String(error)}。请重新检查组件并重试任务。`,
    );
  }
}

/** Different captured bundled bytes must never share an in-flight version report. */
export function mediaToolLaunchProofKey(location: MediaToolLocation): string {
  return location.source === 'bundled'
    ? (locationProofs.get(location)?.signature ?? 'unverified')
    : '';
}

/** Hash unchanged file identities once; enumerate and revalidate the complete tree on every read. */
export function createMediaToolBundleReader(
  directory: string | undefined,
  target: MediaToolBundleTarget = {},
): () => MediaToolBundleState {
  const cache: HashCache = new Map();
  let seen = false;
  return () => {
    if (!directory) return { status: 'absent' };
    try {
      try {
        lstatSync(directory);
        seen = true;
      } catch (error) {
        if (!seen && (error as NodeJS.ErrnoException).code === 'ENOENT')
          return { status: 'absent' };
        throw error;
      }
      return {
        status: 'verified',
        bundle: verifyBundle(directory, target, cache),
      };
    } catch (error) {
      cache.clear();
      return {
        status: 'invalid',
        directory,
        error: `内置视频处理组件校验失败：${error instanceof Error ? error.message : String(error)}。请重新安装可信的应用包，或选择已验证的本机组件。`,
      };
    }
  };
}
