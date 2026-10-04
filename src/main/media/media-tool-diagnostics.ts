import { type ChildProcess, spawn } from 'node:child_process';
import type {
  MediaToolLocation,
  MediaToolResult,
  MediaToolsReport,
} from '../../shared/media-tools';
import { mediaToolStartError, resolveMediaTool } from './media-tools';

type Launch = (command: string, args: string[]) => ChildProcess;
const launch: Launch = (command, args) =>
  spawn(command, args, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** A bounded version check, never a transcode or a codec compatibility claim. */
export function inspectMediaTool(
  location: MediaToolLocation,
  options: { launch?: Launch; timeoutMs?: number } = {},
): Promise<MediaToolResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    let output = '';
    let bytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      status: MediaToolResult['status'],
      detail: string | null,
      version: string | null = null,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...location, status, detail, version });
    };
    const failure = (error: NodeJS.ErrnoException) =>
      finish(
        error.code === 'ENOENT'
          ? 'missing'
          : ['EACCES', 'EPERM'].includes(error.code ?? '')
            ? 'permission-denied'
            : 'failed',
        mediaToolStartError(location, error).message,
      );
    try {
      child = (options.launch ?? launch)(location.command, ['-version']);
    } catch (error) {
      failure(error as NodeJS.ErrnoException);
      return;
    }
    const stop = () => {
      // A version check has no output file to finish. SIGKILL also bounds tools
      // that ignore termination; no shell or child process tree is created here.
      child.kill('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    };
    const read = (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) {
        finish('invalid', '组件返回的信息过多，无法识别版本，请检查组件文件。');
        stop();
        return;
      }
      output += chunk;
    };
    child.stdout?.setEncoding('utf8').on('data', read);
    child.stderr?.setEncoding('utf8').on('data', read);
    child.on('error', failure);
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          'failed',
          `组件启动后异常退出（${code ?? '无退出码'}），请检查系统兼容性和依赖。`,
        );
        return;
      }
      const firstLine = output.split(/\r?\n/, 1)[0]?.trim() ?? '';
      const match = new RegExp(`^${location.name} version (\\S+)`).exec(
        firstLine,
      );
      if (!match?.[1]) {
        finish(
          'invalid',
          '组件未返回可识别的版本，请确认配置指向正确的可执行文件。',
        );
        return;
      }
      finish('available', null, match[1].slice(0, 200));
    });
    timer = setTimeout(() => {
      finish(
        'timeout',
        '组件在 5 秒内没有完成版本检测，请检查组件文件与系统限制。',
      );
      stop();
    }, options.timeoutMs ?? 5000);
  });
}

/** Checks start only on explicit request; repeated requests share the current check. */
export class MediaToolDiagnostics {
  private pending: Promise<MediaToolsReport> | null = null;
  constructor(private inspect = inspectMediaTool) {}
  check(): Promise<MediaToolsReport> {
    if (this.pending) return this.pending;
    this.pending = Promise.all(
      (['ffmpeg', 'ffprobe'] as const).map((name) =>
        this.inspect(resolveMediaTool(name)),
      ),
    )
      .then((tools) => ({ tools, checkedAt: new Date().toISOString() }))
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}
