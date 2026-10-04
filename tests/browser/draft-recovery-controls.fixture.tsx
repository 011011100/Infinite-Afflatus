import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useSaveLifecycle } from '@/features/lifecycle/use-save-lifecycle';
import { ProjectCanvas } from '@/features/workspace/project-canvas';
import type { DesktopBridge } from '../../src/shared/desktop';
import { emptyWorkspace, newShot } from '../../src/shared/generation/workspace';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type { ProjectSnapshot } from '../../src/shared/models';
import type { WorkspaceDraftRecord } from '../../src/shared/workspace-draft';
import { workspaceDraftMock } from './workspace-draft-mock';
import '../../src/renderer/src/styles.css';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const first = newShot('one', '镜头一', { x: 100, y: 200 });
first.nodes.push({
  id: 'text',
  type: 'text',
  text: '磁盘原文字',
  position: { x: 100, y: 200 },
});
const initial = {
  ...emptyWorkspace(),
  shots: [first, newShot('two', '镜头二', { x: 500, y: 200 })],
};
let stored = structuredClone(initial);
const wanted = structuredClone(initial);
const text = wanted.shots[0]?.nodes[0];
if (text?.type === 'text') text.text = '恢复后的完整文字';
const project = {
  id: 'project',
  folder: 'project',
  name: '恢复期间交互',
  updatedAt: '',
};
const record: WorkspaceDraftRecord = {
  format: 'infinite-afflatus-workspace-draft',
  version: 1,
  project,
  sessionId: 'old-session',
  seq: 1,
  baseline: initial,
  workspace: wanted,
  updatedAt: new Date().toISOString(),
  saved: false,
};
const snapshot: ProjectSnapshot = {
  project,
  assets: [],
  canvas: { version: 1, revision: 0, cards: [] },
  viewport: { x: 0, y: 0, zoom: 1 },
};
const committed = deferred();
const reply = deferred();
const refreshed = deferred();
let recoveryStarted = false;
let published = false;
let failed = false;
let nativeSave: (() => Promise<boolean>) | null = null;
const control = {
  commit: committed.resolve,
  reply: reply.resolve,
  refresh: refreshed.resolve,
  fail: () => {
    failed = true;
    committed.resolve();
    reply.resolve();
    refreshed.resolve();
  },
  nativeResult: null as boolean | null,
  leaveResult: null as boolean | null,
  leave: async () => {},
  native: async () => {
    control.nativeResult = (await nativeSave?.()) ?? false;
  },
  state: () => ({ recoveryStarted, published, workspace: stored }),
};
Object.assign(window, { recoveryControls: control });
window.desktop = {
  ...workspaceDraftMock(() => stored).bridge,
  getGenerationWorkspace: async () => structuredClone(stored),
  saveGenerationWorkspace: async (_id, value) => {
    stored = { ...structuredClone(value), revision: value.revision + 1 };
    return structuredClone(stored);
  },
  listWorkspaceDrafts: async () => {
    if (published) await refreshed.promise;
    return { drafts: published ? [] : [structuredClone(record)], issues: [] };
  },
  recoverWorkspaceDraft: async () => {
    recoveryStarted = true;
    await committed.promise;
    if (failed) throw new Error('模拟恢复失败，草稿仍保留');
    stored = { ...structuredClone(wanted), revision: 1 };
    published = true;
    await reply.promise;
    return structuredClone(stored);
  },
  cancelProjectHealth: async () => {},
  cancelProjectPackage: async () => {},
  cancelExportPreparation: async () => {},
  onSaveBeforeLeave: (listener) => {
    nativeSave = listener;
    return () => {
      nativeSave = null;
    };
  },
  onLeaveCancelled: () => () => {},
  saveViewport: async () => {},
} as DesktopBridge;

function Fixture() {
  const lifecycle = useSaveLifecycle();
  const [home, setHome] = useState(false);
  useEffect(() => {
    control.leave = async () => {
      const result = await lifecycle.prepare();
      control.leaveResult = result;
      if (result) setHome(true);
    };
  }, [lifecycle.prepare]);
  return (
    <div className="flex h-screen flex-col" inert={lifecycle.saving}>
      {home ? (
        <p id="home">项目首页</p>
      ) : (
        <ProjectCanvas
          snapshot={snapshot}
          blocked={false}
          inactive={false}
          interactions={defaultInteractionSettings()}
          report={(reason) => {
            throw reason;
          }}
        />
      )}
      {lifecycle.error && <p role="alert">{lifecycle.error}</p>}
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('Missing fixture root');
createRoot(container).render(<Fixture />);
