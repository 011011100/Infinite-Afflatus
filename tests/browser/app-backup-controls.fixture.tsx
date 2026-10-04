import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppSettings } from '@/features/settings/app-settings';
import type { AppBackupInfo, AppBackupList } from '../../src/shared/app-backup';
import type { DesktopBridge } from '../../src/shared/desktop';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type { LibraryState } from '../../src/shared/models';
import '../../src/renderer/src/styles.css';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const backup = (id = 'old'): AppBackupInfo => ({
  id,
  createdAt: '2026-10-05T03:00:00.000Z',
  appVersion: '0.1.0',
  root: '/原项目目录',
  projectCount: 3,
  saveCount: 2,
  bytes: 32768,
  sha256: 'a'.repeat(64),
  restorable: true,
  reason: null,
});
const mode = new URLSearchParams(location.search).get('mode');
let stored: AppBackupList = {
  directory: '/应用数据/app-backups',
  backups: mode === 'empty' ? [] : [backup()],
  issues: [],
  recovery: null,
};
if (mode === 'invalid') {
  stored.backups[0] = {
    ...backup(),
    restorable: false,
    reason: '备份来自不支持的较新版本',
  };
  stored.issues = [
    { file: 'broken.sqlite', message: '文件校验失败，已保留原文件' },
  ];
}
if (mode === 'recovered')
  stored.recovery = {
    restoredAt: '2026-10-05T04:00:00.000Z',
    backupId: 'old',
    retainedDirectory: '/应用数据/retained/原资料',
    retainedJobCount: 2,
    retainedFileCount: 3,
    warning: '原资料已保留，历史任务需要核对。',
  };
const lists: {
  value: AppBackupList;
  pending: ReturnType<typeof deferred<AppBackupList>>;
}[] = [];
const creates: ReturnType<typeof deferred<AppBackupInfo>>[] = [];
const reveals: {
  retained: boolean;
  pending: ReturnType<typeof deferred<void>>;
}[] = [];
let show: (value: boolean) => void = () => {};
let block: (value: boolean) => void = () => {};
const bridge: Pick<
  DesktopBridge,
  | 'getAppBackups'
  | 'createAppBackup'
  | 'revealAppBackups'
  | 'revealRetainedAppData'
  | 'getMediaToolSettings'
> = {
  getAppBackups: async () => {
    const pending = deferred<AppBackupList>();
    lists.push({ value: structuredClone(stored), pending });
    return pending.promise;
  },
  createAppBackup: async () => {
    const pending = deferred<AppBackupInfo>();
    creates.push(pending);
    return pending.promise;
  },
  revealAppBackups: async () => {
    const pending = deferred<void>();
    reveals.push({ retained: false, pending });
    return pending.promise;
  },
  revealRetainedAppData: async () => {
    const pending = deferred<void>();
    reveals.push({ retained: true, pending });
    return pending.promise;
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
  desktop: bridge,
  backupControls: {
    state: () => ({
      lists: lists.length,
      creates: creates.length,
      reveals: reveals.map((item) => item.retained),
      stored,
    }),
    list: (index = lists.length - 1, root?: string) => {
      const request = lists[index];
      if (!request) throw new Error('No list');
      const value = structuredClone(request.value);
      if (root && value.backups[0]) value.backups[0].root = root;
      request.pending.resolve(value);
    },
    failList: () =>
      lists.at(-1)?.pending.reject(new Error('备份目录暂时无法读取')),
    create: () => {
      const pending = creates.at(-1);
      if (!pending) throw new Error('No creation');
      const item = {
        ...backup(`new-${creates.length}`),
        createdAt: '2026-10-05T05:30:00.000Z',
        bytes: 65536,
      };
      stored = { ...stored, backups: [item, ...stored.backups] };
      pending.resolve(item);
    },
    failCreate: () =>
      creates.at(-1)?.reject(new Error('磁盘空间不足，未生成新的备份')),
    reveal: (fail = false) => {
      const request = reveals.at(-1);
      if (!request) throw new Error('No reveal');
      if (fail) request.pending.reject(new Error('无法打开备份位置'));
      else request.pending.resolve();
    },
    show: (value: boolean) => show(value),
    block: (value: boolean) => block(value),
  },
});
const library: LibraryState = {
  root: '/当前项目保存目录',
  projects: [],
  jobs: [],
  migration: null,
  writeBlocked: false,
  interactions: defaultInteractionSettings(),
};
function Fixture() {
  const [visible, setVisible] = useState(true);
  const [blocked, setBlocked] = useState(false);
  show = setVisible;
  block = setBlocked;
  return visible ? (
    <AppSettings
      library={{ ...library, writeBlocked: blocked }}
      onClose={() => setVisible(false)}
      run={async (operation) => {
        await operation();
      }}
      error={null}
    />
  ) : (
    <p>设置已关闭</p>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
