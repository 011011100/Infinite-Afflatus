import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button } from '@/components/ui/button';
import { AppSettings } from '@/features/settings/app-settings';
import type { DesktopBridge } from '../../src/shared/desktop';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type { LibraryState } from '../../src/shared/models';
import type {
  PreviewCacheCleanupPreview,
  PreviewCacheCleanupResult,
  PreviewCacheItem,
} from '../../src/shared/preview-cache';
import { appBackupMock } from './app-backup-mock';
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
const item = (
  relativePath: string,
  bytes: number | null,
  reason: string,
  canCleanup = false,
  kind: PreviewCacheItem['kind'] = 'proxy',
): PreviewCacheItem => ({
  projectId: 'project-A',
  projectName: '合成测试项目',
  assetId: kind === 'proxy' ? relativePath : null,
  relativePath,
  kind,
  bytes,
  canCleanup,
  reason,
});
const files: [PreviewCacheItem, PreviewCacheItem] = [
  item('cache/proxy-a.mp4', 513, '已核实为可重建的受管预览。', true),
  item('cache/proxy-b.mp4', 1025, '已核实为可重建的旧版受管预览。', true),
];
const retained = [
  item('cache/proxy-playing.mp4', 2048, '正在使用，已保留。'),
  item('cache/proxy-generating.mp4', 512, '正在生成，已保留。'),
  item('cache/proxy-original-missing.mp4', 333, '原素材不可用，已保留。'),
  item(
    'cache/user-file.txt',
    4096,
    '身份不明的文件，已保留。',
    false,
    'unknown',
  ),
  item(
    'cache/unreadable',
    null,
    '目录无法安全核实，未进入。',
    false,
    'unknown',
  ),
];
const previews: ReturnType<typeof deferred<PreviewCacheCleanupPreview>>[] = [];
const executions: {
  token: string;
  deferred: ReturnType<typeof deferred<PreviewCacheCleanupResult>>;
}[] = [];
let inspections = 0;
let cancellations = 0;
let failCancel = false;
let show: (value: boolean) => void = () => {};
let block: (value: boolean) => void = () => {};
let cleanupMigration: (value: boolean) => void = () => {};
const bridge: Pick<
  DesktopBridge,
  | 'inspectPreviewCache'
  | 'previewCacheCleanup'
  | 'executePreviewCacheCleanup'
  | 'cancelPreviewCacheOperations'
  | 'getMediaToolSettings'
> = {
  inspectPreviewCache: async () => {
    inspections++;
    return {
      items: [],
      bytes: 0,
      eligibleCount: 0,
      eligibleBytes: 0,
      incomplete: false,
    };
  },
  previewCacheCleanup: () => {
    const next = deferred<PreviewCacheCleanupPreview>();
    previews.push(next);
    return next.promise;
  },
  executePreviewCacheCleanup: (token) => {
    const next = deferred<PreviewCacheCleanupResult>();
    executions.push({ token, deferred: next });
    return next.promise;
  },
  cancelPreviewCacheOperations: async () => {
    cancellations++;
    if (failCancel) {
      failCancel = false;
      throw new Error('取消通道暂不可用');
    }
  },
  getMediaToolSettings: async () => ({
    paths: { ffmpeg: null, ffprobe: null },
    locations: {
      ffmpeg: { name: 'ffmpeg', command: 'ffmpeg', source: 'path' },
      ffprobe: { name: 'ffprobe', command: 'ffprobe', source: 'path' },
    },
    error: null,
  }),
};
Object.assign(window, {
  desktop: { ...bridge, ...appBackupMock() },
  previewCacheControls: {
    state: () => ({
      inspections,
      previews: previews.length,
      executions: executions.map(({ token }) => token),
      cancellations,
    }),
    preview: (index = previews.length - 1, expires = 60000, empty = false) =>
      previews[index]?.resolve({
        token: empty ? null : `preview-${index}`,
        expiresAt: empty ? null : new Date(Date.now() + expires).toISOString(),
        files: empty ? [] : structuredClone(files),
        bytes: empty ? 0 : 1538,
        retained: structuredClone(retained),
        incomplete: true,
      }),
    failPreview: (index = previews.length - 1) =>
      previews[index]?.reject(new Error('缓存目录暂不可读')),
    finish: (
      index = executions.length - 1,
      partial = false,
      cancelled = false,
    ) =>
      executions[index]?.deferred.resolve({
        removedCount: partial ? 1 : 2,
        removedBytes: partial ? 513 : 1538,
        retained: partial
          ? [
              {
                ...files[1],
                canCleanup: false,
                reason: cancelled
                  ? '已停止，文件保留。'
                  : '文件被占用，未清理。',
              },
            ]
          : [],
        cancelled,
      }),
    failExecution: (index = executions.length - 1) =>
      executions[index]?.deferred.reject(
        new Error('缓存或原素材已变化，请重新检查后确认。'),
      ),
    rejectNextCancel: () => {
      failCancel = true;
    },
    show: (value: boolean) => show(value),
    block: (value: boolean) => block(value),
    cleanupMigration: (value: boolean) => cleanupMigration(value),
  },
});

function Fixture() {
  const [settings, setSettings] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [migration, setMigration] = useState<LibraryState['migration']>(null);
  show = setSettings;
  block = setBlocked;
  cleanupMigration = (value) =>
    setMigration(
      value
        ? {
            id: 'fixture-migration',
            source: '/isolated/old-library',
            target: '/isolated/project-library',
            phase: 'cleaning',
            copied: 2,
            total: 2,
            error: '旧目录清理待重试',
            warnings: [],
          }
        : null,
    );
  const library: LibraryState = {
    root: '/isolated/project-library',
    projects: [],
    jobs: [],
    migration,
    writeBlocked: blocked,
    interactions: defaultInteractionSettings(),
  };
  return (
    <>
      <Button onClick={() => setSettings(true)}>打开设置</Button>
      {settings && (
        <AppSettings
          library={library}
          run={async (action) => {
            await action();
          }}
          error={null}
          onClose={() => setSettings(false)}
        />
      )}
    </>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
