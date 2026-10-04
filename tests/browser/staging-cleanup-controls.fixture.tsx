import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppSettings } from '@/features/settings/app-settings';
import { SaveStatus } from '@/features/settings/save-status';
import type { DesktopBridge } from '../../src/shared/desktop';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type { LibraryState, SaveJob } from '../../src/shared/models';
import type {
  StagingCleanupPreview,
  StagingCleanupResult,
  StagingInspection,
  StagingItem,
} from '../../src/shared/staging-cleanup';
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
const job = (id: string): SaveJob => ({
  id,
  projectId: 'project',
  resultKey: `reference:${id}`,
  name: `${id}.mp4`,
  kind: 'video',
  usage: 'reference',
  extension: '.mp4',
  status: 'failed',
  size: 1024,
  sha256: 'a'.repeat(64),
  error: '测试保存或接收失败',
  createdAt: '2026-10-05T00:00:00.000Z',
});
const initialJobs = [job('完整结果'), job('取消导入')];
const items: [StagingItem, StagingItem] = [
  {
    jobId: '完整结果',
    name: '完整结果.mp4',
    category: 'save-failed',
    cancelled: false,
    bytes: 1024,
    canRetry: true,
    canCleanup: false,
    reason: '完整结果已保留，可重试保存。',
  },
  {
    jobId: '取消导入',
    name: '取消导入.mp4',
    category: 'incomplete-local',
    cancelled: true,
    bytes: 513,
    canRetry: false,
    canCleanup: true,
    reason: '已取消，未完成的本地导入。',
  },
];
const inspections: ReturnType<typeof deferred<StagingInspection>>[] = [];
const previews: ReturnType<typeof deferred<StagingCleanupPreview>>[] = [];
const executions: {
  token: string;
  deferred: ReturnType<typeof deferred<StagingCleanupResult>>;
}[] = [];
const retryIds: string[] = [];
let changeJobs: (jobs: SaveJob[]) => void = () => {};
let closeSettings: () => void = () => {};
let currentJobs = structuredClone(initialJobs);
const controls = {
  state: () => ({
    inspections: inspections.length,
    previews: previews.length,
    executions: executions.map(({ token }) => token),
    retryIds,
  }),
  inspect: (index = inspections.length - 1, retry = true) => {
    const next = structuredClone(items);
    next[0].canRetry = retry;
    inspections[index]?.resolve({ items: next });
  },
  failInspection: (index = inspections.length - 1) =>
    inspections[index]?.reject(new Error('暂存状态读取失败')),
  refresh: () => changeJobs(structuredClone(currentJobs)),
  changeOtherJob: () => {
    currentJobs = currentJobs.map((job, i) =>
      i === 1 ? { ...job, error: `${job.error}（更新）` } : job,
    );
    changeJobs(structuredClone(currentJobs));
  },
  changeJob: () => {
    currentJobs = currentJobs.map((job, i) =>
      i === 0 ? { ...job, error: `${job.error}（更新）` } : job,
    );
    changeJobs(structuredClone(currentJobs));
  },
  preview: (index = previews.length - 1, expires = 60000) =>
    previews[index]?.resolve({
      token: `preview-${index}`,
      expiresAt: new Date(Date.now() + expires).toISOString(),
      files: [
        { jobId: '取消导入', name: '取消导入.mp4', bytes: 513 },
        { jobId: '接收失败', name: '接收失败.wav', bytes: 1025 },
      ],
      bytes: 1538,
      retained: [
        items[0],
        {
          jobId: '云端结果',
          name: '云端结果.mp4',
          category: 'retained-result',
          cancelled: false,
          bytes: 2048,
          canRetry: false,
          canCleanup: false,
          reason: '云端结果不在本地导入回收范围，已保留。',
        },
        {
          jobId: '旧暂存',
          name: '旧暂存.part',
          category: 'incomplete-local',
          cancelled: false,
          bytes: null,
          canRetry: false,
          canCleanup: false,
          reason: '缺少创建归属记录，历史文件已保留。',
        },
      ],
    }),
  emptyPreview: (index = previews.length - 1) =>
    previews[index]?.resolve({
      token: null,
      expiresAt: null,
      files: [],
      bytes: 0,
      retained: [items[0]],
    }),
  failPreview: (index = previews.length - 1) =>
    previews[index]?.reject(new Error('暂存目录暂不可读')),
  execute: (partial = false, index = executions.length - 1) =>
    executions[index]?.deferred.resolve({
      removedCount: partial ? 1 : 2,
      removedBytes: partial ? 513 : 1538,
      retained: partial
        ? [
            {
              jobId: '接收失败',
              name: '接收失败.wav',
              reason: '文件被占用，未清理',
            },
          ]
        : [],
    }),
  failExecution: (index = executions.length - 1) =>
    executions[index]?.deferred.reject(
      new Error('文件或任务已变化，请重新检查后确认。'),
    ),
  close: () => closeSettings(),
};
Object.assign(window, { cleanupControls: controls });
window.desktop = {
  getMediaToolSettings: async () => ({
    paths: { ffmpeg: null, ffprobe: null },
    locations: {
      ffmpeg: { name: 'ffmpeg', command: 'ffmpeg', source: 'path' },
      ffprobe: { name: 'ffprobe', command: 'ffprobe', source: 'path' },
    },
    error: null,
  }),
  inspectStaging: () => {
    const next = deferred<StagingInspection>();
    inspections.push(next);
    return next.promise;
  },
  previewStagingCleanup: () => {
    const next = deferred<StagingCleanupPreview>();
    previews.push(next);
    return next.promise;
  },
  executeStagingCleanup: (token) => {
    const next = deferred<StagingCleanupResult>();
    executions.push({ token, deferred: next });
    return next.promise;
  },
  cancelStagingOperations: async () => {},
  retrySave: async (id) => {
    retryIds.push(id);
  },
} as DesktopBridge;

function Fixture() {
  const [jobs, setJobs] = useState(initialJobs);
  const [settings, setSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    changeJobs = setJobs;
    closeSettings = () => setSettings(false);
    return () => {
      changeJobs = () => {};
      closeSettings = () => {};
    };
  }, []);
  const run = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (reason) {
      setError(String(reason));
    }
  };
  const library: LibraryState = {
    root: '/isolated/project-library',
    jobs,
    projects: [],
    interactions: defaultInteractionSettings(),
    migration: null,
    writeBlocked: false,
  };
  return (
    <>
      <SaveStatus
        jobs={jobs}
        migrating={false}
        run={run}
        onManageStaging={() => setSettings(true)}
      />
      {settings && (
        <AppSettings
          library={library}
          run={run}
          error={error}
          initialPage="storage"
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
