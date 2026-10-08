import { type ChildProcess, spawn } from 'node:child_process';
import type {
  MediaToolLocation,
  MediaToolPair,
  MediaToolResult,
  MediaToolsReport,
} from '../../shared/media-tools';
import {
  assertMediaToolLaunch,
  mediaToolLaunchProofKey,
} from './media-tool-bundle';
import { mediaToolStartError, resolveMediaToolPair } from './media-tools';

type Launch = (command: string, args: string[]) => ChildProcess;
export interface MediaToolInspectionOptions {
  launch?: Launch;
  timeoutMs?: number;
  signal?: AbortSignal;
}
const launch: Launch = (command, args) =>
  spawn(command, args, {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** A bounded version check, never a transcode or a codec compatibility claim. */
export function inspectMediaTool(
  location: MediaToolLocation,
  options: MediaToolInspectionOptions = {},
): Promise<MediaToolResult> {
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  try {
    assertMediaToolLaunch(location);
  } catch (error) {
    return Promise.resolve({
      ...location,
      status: 'invalid',
      version: null,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return new Promise((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let child: ChildProcess;
    let output = '';
    let bytes = 0;
    let settled = false;
    let stopping: { result: MediaToolResult } | { error: unknown } | null =
      null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = (
      status: MediaToolResult['status'],
      detail: string | null,
      version: string | null = null,
    ): MediaToolResult => ({ ...location, status, detail, version });
    const finish = (
      value: { result: MediaToolResult } | { error: unknown },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if ('error' in value) reject(value.error);
      else resolve(value.result);
    };
    const failure = (error: NodeJS.ErrnoException) => ({
      result: result(
        error.code === 'ENOENT'
          ? 'missing'
          : ['EACCES', 'EPERM'].includes(error.code ?? '')
            ? 'permission-denied'
            : 'failed',
        mediaToolStartError(location, error).message,
      ),
    });
    const stop = (value: NonNullable<typeof stopping>) => {
      if (settled || stopping) return;
      stopping = value;
      clearTimeout(timer);
      // Wait for close: cancellation must finish the process and its pipe handles
      // before application shutdown closes services. No shell/process tree is used.
      child.kill('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const abort = () => stop({ error: signal?.reason });
    try {
      child = (options.launch ?? launch)(location.command, ['-version']);
    } catch (error) {
      finish(failure(error as NodeJS.ErrnoException));
      return;
    }
    const read = (chunk: string) => {
      if (settled || stopping) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) {
        stop({
          result: result(
            'invalid',
            '组件返回的信息过多，无法识别版本，请检查组件文件。',
          ),
        });
        return;
      }
      output += chunk;
    };
    child.stdout?.setEncoding('utf8').on('data', read);
    child.stderr?.setEncoding('utf8').on('data', read);
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled || stopping) return;
      // Even a failed spawn owns pipe handles. Node emits close after error,
      // and only then may a caller finish shutdown or begin a replacement check.
      stopping = failure(error);
      clearTimeout(timer);
      child.stdout?.destroy();
      child.stderr?.destroy();
    });
    child.once('close', (code) => {
      if (settled) return;
      if (stopping) {
        finish(stopping);
        return;
      }
      if (code !== 0) {
        finish({
          result: result(
            'failed',
            `组件启动后异常退出（${code ?? '无退出码'}），请检查系统兼容性和依赖。`,
          ),
        });
        return;
      }
      const firstLine = output.split(/\r?\n/, 1)[0]?.trim() ?? '';
      const match = new RegExp(`^${location.name} version (\\S+)`).exec(
        firstLine,
      );
      if (!match?.[1]) {
        finish({
          result: result(
            'invalid',
            '组件未返回可识别的版本，请确认配置指向正确的可执行文件。',
          ),
        });
        return;
      }
      finish({ result: result('available', null, match[1].slice(0, 200)) });
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else
      timer = setTimeout(() => {
        stop({
          result: result(
            'timeout',
            '组件在 5 秒内没有完成版本检测，请检查组件文件与系统限制。',
          ),
        });
      }, options.timeoutMs ?? 5000);
  });
}

/** Explicit checks share only requests for the same captured pair of commands. */
export class MediaToolDiagnostics {
  private pending = new Map<string, Promise<MediaToolsReport>>();
  private controller = new AbortController();
  constructor(private inspect = inspectMediaTool) {}
  check(
    pair: MediaToolPair = resolveMediaToolPair(),
  ): Promise<MediaToolsReport> {
    if (this.controller.signal.aborted)
      return Promise.reject(this.controller.signal.reason);
    const key = JSON.stringify([
      pair,
      mediaToolLaunchProofKey(pair.ffmpeg),
      mediaToolLaunchProofKey(pair.ffprobe),
    ]);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const pending = Promise.allSettled(
      (['ffmpeg', 'ffprobe'] as const).map((name) =>
        this.inspect(pair[name], { signal: this.controller.signal }),
      ),
    )
      .then((results) => {
        const tools = results.map((result) => {
          if (result.status === 'rejected') throw result.reason;
          return result.value;
        });
        return { tools, checkedAt: new Date().toISOString() };
      })
      .finally(() => {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      });
    this.pending.set(key, pending);
    return pending;
  }
  async close(): Promise<void> {
    this.controller.abort(new Error('视频处理组件检测已关闭'));
    await Promise.allSettled(this.pending.values());
  }
}
