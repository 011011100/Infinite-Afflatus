import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type {
  MediaToolName,
  MediaToolPair,
  MediaToolPaths,
  MediaToolSettingsChange,
  MediaToolSettingsState,
  MediaToolsReport,
} from '../../shared/media-tools';
import type { AppStore } from '../storage/app-store';
import {
  inspectMediaTool,
  MediaToolDiagnostics,
} from './media-tool-diagnostics';
import {
  MEDIA_TOOL_ENV,
  type MediaToolResolutionOptions,
  mediaToolStartError,
  resolveMediaToolPair,
} from './media-tools';

const key = 'mediaToolSettings';
const emptyPaths = (): MediaToolPaths => ({ ffmpeg: null, ffprobe: null });
const invalidSettings =
  '保存的视频处理配置损坏或版本不受支持。请清除两项保存路径后重新配置。';
type Store = Pick<AppStore, 'get' | 'hasSetting' | 'set'>;
type Options = MediaToolResolutionOptions & {
  inspect?: typeof inspectMediaTool;
};
type CurrentWindow = () => void;

function validPath(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length <= 32767 &&
      !value.includes('\0') &&
      isAbsolute(value))
  );
}
function decode(value: unknown): MediaToolPaths {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(invalidSettings);
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    Object.keys(row).length !== 3 ||
    !validPath(row.ffmpeg) ||
    !validPath(row.ffprobe)
  )
    throw new Error(invalidSettings);
  return { ffmpeg: row.ffmpeg, ffprobe: row.ffprobe };
}

async function executableIdentity(path: string) {
  if ((await realpath(path)) !== path)
    throw new Error('所选组件路径已经变化，请重新选择。');
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('请选择普通的组件可执行文件。');
  await access(path, constants.X_OK);
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

async function selectedExecutable(name: MediaToolName, selected: string) {
  try {
    const command = await realpath(selected);
    return { command, identity: await executableIdentity(command) };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException;
    if (failure.code)
      throw mediaToolStartError(
        { name, command: selected, source: 'saved' },
        failure,
      );
    throw error;
  }
}

/** Only local application settings; no project, environment, or installed tool is modified. */
export class MediaToolSettings {
  private tail: Promise<void> = Promise.resolve();
  private controller = new AbortController();
  private diagnostics: MediaToolDiagnostics;
  private inspect: typeof inspectMediaTool;
  private closed: Promise<void> | null = null;
  constructor(
    private store: Store,
    private options: Options = {},
  ) {
    this.inspect = options.inspect ?? inspectMediaTool;
    this.diagnostics = new MediaToolDiagnostics(this.inspect);
  }

  state(): MediaToolSettingsState {
    let paths: MediaToolPaths | null = null;
    let error: string | null = null;
    try {
      paths = this.store.hasSetting(key)
        ? decode(this.store.get(key))
        : emptyPaths();
    } catch {
      error = invalidSettings;
    }
    return {
      paths,
      locations: resolveMediaToolPair(paths ?? undefined, this.options),
      error,
    };
  }

  snapshot(): MediaToolPair {
    this.controller.signal.throwIfAborted();
    const state = this.state();
    if (state.error) throw new Error(state.error);
    return state.locations;
  }

  check(): Promise<MediaToolsReport> {
    return this.diagnostics.check(this.snapshot());
  }

  choose(
    name: MediaToolName,
    choosePath: () => Promise<string | null>,
    assertCurrent: CurrentWindow,
  ): Promise<MediaToolSettingsChange | null> {
    return this.mutate(async () => {
      this.assertEditable(name);
      assertCurrent();
      const selected = await this.pick(choosePath);
      this.controller.signal.throwIfAborted();
      assertCurrent();
      if (selected === null) return null;
      if (!validPath(selected))
        throw new Error('请选择组件可执行文件的完整路径。');
      const { command, identity } = await selectedExecutable(name, selected);
      const location = { name, command, source: 'saved' as const };
      const result = await this.inspect(location, {
        signal: this.controller.signal,
      });
      this.controller.signal.throwIfAborted();
      assertCurrent();
      if (result.status !== 'available')
        throw new Error(result.detail ?? '组件验证失败，原配置未改变。');
      const verified = await selectedExecutable(name, command);
      if (verified.command !== command || verified.identity !== identity)
        throw new Error('组件文件在检查期间发生变化，请重新选择。');
      const paths = this.assertEditable(name);
      this.controller.signal.throwIfAborted();
      assertCurrent();
      this.store.set(key, { version: 1, ...paths, [name]: command });
      return {
        settings: this.state(),
        report: { checkedAt: new Date().toISOString(), tools: [result] },
      };
    });
  }

  reset(
    name: MediaToolName | 'all',
    assertCurrent: CurrentWindow,
  ): Promise<MediaToolSettingsChange> {
    return this.mutate(async () => {
      assertCurrent();
      let paths: MediaToolPaths;
      if (name === 'all') {
        if (!this.state().error)
          throw new Error('清除两项路径仅用于修复损坏的视频处理配置。');
        paths = emptyPaths();
      } else paths = { ...this.assertEditable(name), [name]: null };
      const locations = resolveMediaToolPair(paths, this.options);
      // Reset is meaningful even if automatic discovery cannot find a tool.
      // Complete diagnosis before persisting so closure and write failure keep the old value.
      const names = name === 'all' ? (['ffmpeg', 'ffprobe'] as const) : [name];
      const results = await Promise.allSettled(
        names.map((tool) =>
          this.inspect(locations[tool], { signal: this.controller.signal }),
        ),
      );
      const tools = results.map((result) => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
      this.controller.signal.throwIfAborted();
      assertCurrent();
      if (name !== 'all') this.assertEditable(name);
      this.store.set(key, { version: 1, ...paths });
      return {
        settings: this.state(),
        report: { checkedAt: new Date().toISOString(), tools },
      };
    });
  }

  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.controller.abort(new Error('视频处理设置已关闭'));
    this.closed = Promise.allSettled([
      this.tail,
      this.diagnostics.close(),
    ]).then(() => {});
    return this.closed;
  }

  private assertEditable(name: MediaToolName): MediaToolPaths {
    this.controller.signal.throwIfAborted();
    const state = this.state();
    if (!state.paths || state.error)
      throw new Error(state.error ?? invalidSettings);
    if (state.locations[name].source === 'environment')
      throw new Error(
        `${MEDIA_TOOL_ENV[name]} 已指定此组件，请先移除该环境变量后再更改应用配置。`,
      );
    return state.paths;
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const task = this.tail.then(() => {
      this.controller.signal.throwIfAborted();
      return action();
    });
    this.tail = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  private async pick(
    choosePath: () => Promise<string | null>,
  ): Promise<string | null> {
    const signal = this.controller.signal;
    signal.throwIfAborted();
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return choosePath();
        }),
        cancelled,
      ]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
}
