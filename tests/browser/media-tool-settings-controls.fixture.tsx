import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MediaToolsSettings } from '@/features/settings/media-tools-settings';
import type { DesktopBridge } from '../../src/shared/desktop';
import type {
  MediaToolName,
  MediaToolSettingsChange,
  MediaToolSettingsState,
  MediaToolsReport,
} from '../../src/shared/media-tools';
import '../../src/renderer/src/styles.css';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const names = ['ffmpeg', 'ffprobe'] as const;
const auto: MediaToolSettingsState = {
  paths: { ffmpeg: null, ffprobe: null },
  locations: {
    ffmpeg: { name: 'ffmpeg', command: 'ffmpeg', source: 'path' },
    ffprobe: { name: 'ffprobe', command: 'ffprobe', source: 'path' },
  },
  error: null,
};
let stored = structuredClone(auto);
const mode = new URLSearchParams(location.search).get('mode');
if (mode === 'saved' || mode === 'environment') {
  for (const name of names) {
    const command = `/已保存 路径/${name}`;
    if (stored.paths) stored.paths[name] = command;
    stored.locations = {
      ...stored.locations,
      [name]: { name, command, source: 'saved' },
    };
  }
}
if (mode === 'environment')
  stored.locations = {
    ...stored.locations,
    ffmpeg: {
      name: 'ffmpeg',
      command: '/环境变量/ffmpeg',
      source: 'environment',
    },
  };
if (mode === 'broken') {
  stored.paths = null;
  stored.error = '组件配置来自较新版本，原值已保留。';
}
function bundleState(invalid: boolean) {
  for (const name of names)
    stored.locations = {
      ...stored.locations,
      [name]: {
        name,
        source: 'bundled',
        command: invalid ? `/内置组件/${name}` : `/内置组件/bin/${name}`,
        ...(invalid
          ? { unavailableReason: '内置组件校验失败：测试散列不匹配' }
          : {}),
      },
    };
}
if (mode === 'bundled' || mode === 'bundled-invalid')
  bundleState(mode === 'bundled-invalid');
const report = (
  settings: MediaToolSettingsState,
  tools: readonly MediaToolName[] = names,
): MediaToolsReport => ({
  checkedAt: new Date().toISOString(),
  tools: tools.map((name) => ({
    ...settings.locations[name],
    status: settings.locations[name].unavailableReason
      ? 'invalid'
      : 'available',
    version: settings.locations[name].unavailableReason
      ? null
      : settings.locations[name].source === 'saved'
        ? '8.2.saved'
        : '8.1.auto',
    detail: settings.locations[name].unavailableReason ?? null,
  })),
});
const reads: {
  snapshot: MediaToolSettingsState;
  pending: ReturnType<typeof deferred<MediaToolSettingsState>>;
}[] = [];
const checks: {
  snapshot: MediaToolSettingsState;
  pending: ReturnType<typeof deferred<MediaToolsReport>>;
}[] = [];
const choices: {
  name: MediaToolName;
  pending: ReturnType<typeof deferred<MediaToolSettingsChange | null>>;
}[] = [];
const resets: {
  name: MediaToolName | 'all';
  pending: ReturnType<typeof deferred<MediaToolSettingsChange>>;
}[] = [];
let show: (visible: boolean) => void = () => {};
const bridge: Pick<
  DesktopBridge,
  | 'getMediaToolSettings'
  | 'checkMediaTools'
  | 'chooseMediaTool'
  | 'resetMediaTool'
> = {
  getMediaToolSettings: () => {
    const pending = deferred<MediaToolSettingsState>();
    reads.push({ snapshot: structuredClone(stored), pending });
    return pending.promise;
  },
  checkMediaTools: () => {
    const pending = deferred<MediaToolsReport>();
    checks.push({ snapshot: structuredClone(stored), pending });
    return pending.promise;
  },
  chooseMediaTool: (name) => {
    const pending = deferred<MediaToolSettingsChange | null>();
    choices.push({ name, pending });
    return pending.promise;
  },
  resetMediaTool: (name) => {
    const pending = deferred<MediaToolSettingsChange>();
    resets.push({ name, pending });
    return pending.promise;
  },
};
Object.assign(window, {
  desktop: bridge,
  toolsControls: {
    bundleState,
    state: () => ({
      reads: reads.length,
      checks: checks.length,
      choices: choices.map(({ name }) => name),
      resets: resets.map(({ name }) => name),
      stored,
    }),
    read: (index = reads.length - 1) =>
      reads[index]?.pending.resolve(reads[index].snapshot),
    failRead: () => reads.at(-1)?.pending.reject(new Error('配置暂时无法读取')),
    check: (index = checks.length - 1, mismatch = '') => {
      const request = checks[index];
      if (!request) throw new Error('Missing check request');
      const result = report(request.snapshot);
      const first = result.tools[0];
      if (!first) throw new Error('Missing fixture media tool');
      if (mismatch === 'command') first.command = '/旧工具/ffmpeg';
      if (mismatch === 'source') first.source = 'environment';
      if (mismatch === 'name') first.name = 'ffprobe';
      request.pending.resolve(result);
    },
    choose: (command: string | null, index = choices.length - 1) => {
      const request = choices[index];
      if (!request) throw new Error('Missing choice request');
      if (command === null) return request.pending.resolve(null);
      if (!stored.paths) throw new Error('Cannot overwrite invalid settings');
      stored = {
        ...stored,
        paths: { ...stored.paths, [request.name]: command },
        locations: {
          ...stored.locations,
          [request.name]: { name: request.name, command, source: 'saved' },
        },
      };
      request.pending.resolve({
        settings: structuredClone(stored),
        report: report(stored, [request.name]),
      });
    },
    failChoice: () =>
      choices
        .at(-1)
        ?.pending.reject(
          new Error(
            "Error invoking remote method 'media:choose-tool': Error: 所选文件不是 FFmpeg，原配置未改变",
          ),
        ),
    reset: () => {
      const request = resets.at(-1);
      if (!request) throw new Error('Missing reset request');
      const affected = request.name === 'all' ? names : [request.name];
      stored.paths ??= { ffmpeg: null, ffprobe: null };
      for (const name of affected) {
        stored.paths[name] = null;
        if (stored.locations[name].source !== 'environment')
          stored.locations = {
            ...stored.locations,
            [name]: auto.locations[name],
          };
      }
      stored.error = null;
      request.pending.resolve({
        settings: structuredClone(stored),
        report: report(stored, affected),
      });
    },
    close: () => show(false),
    open: () => show(true),
  },
});
function Fixture() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    show = setVisible;
  }, []);
  return (
    <main className="mx-auto max-w-xl p-6">
      {visible ? <MediaToolsSettings /> : <p>设置已关闭</p>}
    </main>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
