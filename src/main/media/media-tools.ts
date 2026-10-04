import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  MediaToolLocation,
  MediaToolName,
  MediaToolPair,
  MediaToolPaths,
} from '../../shared/media-tools';

export const MEDIA_TOOL_ENV = {
  ffmpeg: 'FFMPEG_PATH',
  ffprobe: 'FFPROBE_PATH',
} as const;

export interface MediaToolResolutionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  executable?: (file: string) => boolean;
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Diagnosis and real media work use the same resolution; explicit configuration never falls back. */
export function resolveMediaTool(
  name: MediaToolName,
  options: MediaToolResolutionOptions & { saved?: string | null } = {},
): MediaToolLocation {
  const env = options.env ?? process.env;
  const configured = env[MEDIA_TOOL_ENV[name]];
  if (configured) return { name, command: configured, source: 'environment' };
  if (options.saved) return { name, command: options.saved, source: 'saved' };
  if ((options.platform ?? process.platform) === 'darwin') {
    const executable = options.executable ?? isExecutable;
    // Finder does not normally inherit a shell's Homebrew PATH. Prefer the actual
    // process PATH, then known installation locations, without changing the environment.
    for (const directory of (env.PATH ?? '/usr/bin:/bin').split(':')) {
      const candidate = join(directory, name);
      if (executable(candidate))
        return { name, command: candidate, source: 'path' };
    }
    for (const directory of ['/opt/homebrew/bin', '/usr/local/bin']) {
      const candidate = join(directory, name);
      if (executable(candidate))
        return { name, command: candidate, source: 'standard-location' };
    }
  }
  return { name, command: name, source: 'path' };
}

/** Capture both commands once; tasks retain their own immutable configuration. */
export function resolveMediaToolPair(
  paths?: MediaToolPaths,
  options: MediaToolResolutionOptions = {},
): MediaToolPair {
  return Object.freeze({
    ffmpeg: Object.freeze(
      resolveMediaTool('ffmpeg', { ...options, saved: paths?.ffmpeg ?? null }),
    ),
    ffprobe: Object.freeze(
      resolveMediaTool('ffprobe', {
        ...options,
        saved: paths?.ffprobe ?? null,
      }),
    ),
  });
}

export function mediaToolStartError(
  location: MediaToolLocation,
  error: NodeJS.ErrnoException,
): Error {
  const label = location.name === 'ffmpeg' ? 'FFmpeg' : 'FFprobe';
  const guidance = '请打开“设置 → 视频处理”检查组件与配置';
  if (error.code === 'ENOENT') return new Error(`未找到 ${label}；${guidance}`);
  if (error.code === 'EACCES' || error.code === 'EPERM')
    return new Error(
      `${label} 无法执行，请检查文件权限或系统限制；${guidance}`,
    );
  if (error.code === 'ENOEXEC' || error.code === 'EINVAL')
    return new Error(
      `${label} 无法启动，请检查组件是否适用于当前系统；${guidance}`,
    );
  return new Error(`${label} 启动失败：${error.message}；${guidance}`);
}
