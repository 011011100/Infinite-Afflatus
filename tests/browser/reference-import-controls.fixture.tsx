import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HoldFeedbackProvider } from '@/components/canvas/hold-feedback';
import { MaterialCanvas } from '@/features/generation/material-canvas';
import type { ImportedReferenceNode } from '@/features/generation/reference-import-target';
import { useReferenceImport } from '@/features/generation/use-reference-import';
import { SaveLifecycleStatus } from '@/features/lifecycle/save-lifecycle-status';
import { useSaveLifecycle } from '@/features/lifecycle/use-save-lifecycle';
import { ProjectCanvas } from '@/features/workspace/project-canvas';
import type { DesktopBridge } from '../../src/shared/desktop';
import type { ReferenceImportResult } from '../../src/shared/generation/draft';
import type { ReferenceImportProgress } from '../../src/shared/generation/reference-import';
import { emptyWorkspace, newShot } from '../../src/shared/generation/workspace';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type { ProjectSnapshot } from '../../src/shared/models';
import type { WorkspaceDraftRecord } from '../../src/shared/workspace-draft';
import { workspaceDraftMock } from './workspace-draft-mock';
import '../../src/renderer/src/styles.css';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const workspace = {
  ...emptyWorkspace(),
  shots: [newShot('shot', '测试镜头', { x: 100, y: 180 })],
};
let stored = structuredClone(workspace);
const drafts = workspaceDraftMock(() => stored);
if (new URLSearchParams(location.search).has('draft')) {
  const wanted = structuredClone(workspace);
  wanted.shots[0]?.nodes.push({
    id: 'old-text',
    type: 'text',
    text: '旧恢复内容',
    position: { x: 0, y: 0 },
  });
  const record: WorkspaceDraftRecord = {
    format: 'infinite-afflatus-workspace-draft',
    version: 1,
    project: { id: 'project', folder: 'project', name: '测试项目' },
    sessionId: 'old-session',
    seq: 1,
    baseline: structuredClone(workspace),
    workspace: wanted,
    saved: false,
    updatedAt: new Date().toISOString(),
  };
  drafts.records.set('project.old-session', record);
}
const snapshot: ProjectSnapshot = {
  project: {
    id: 'project',
    folder: 'project',
    name: '导入取消',
    updatedAt: '',
  },
  assets: [],
  canvas: { version: 1, revision: 0, cards: [] },
  viewport: { x: 0, y: 0, zoom: 1 },
};
type Batch = {
  id: string;
  cancelled: boolean;
  done: boolean;
  result: ReturnType<typeof deferred<ReferenceImportResult>>;
};
const batches: Batch[] = [];
const events: string[] = [];
const pauses = new Set<string>();
const progressListeners = new Set<(p: ReferenceImportProgress) => void>();
let nativeSave: (() => Promise<boolean>) | null = null;
let leaveCancelled: (() => void) | null = null;
let failing = false;
let unavailable = false;
let setUnavailable: (value: boolean) => void = () => {};
let recoveryCalls = 0;
let allowAppend = false;
const appendAttempts: ImportedReferenceNode[][] = [];
let saveGate: ReturnType<typeof deferred<void>> | null = null;
const emit = (
  bytes: number,
  index = batches.length - 1,
  phase: ReferenceImportProgress['phase'] = 'receiving',
) => {
  const batch = batches[index];
  if (!batch) throw new Error('No batch');
  for (const listener of progressListeners)
    listener({
      projectId: 'project',
      requestId: batch.id,
      phase,
      fileIndex: 2,
      totalFiles: 3,
      fileName: `缓慢文件-${index + 1}.mp4`,
      receivedBytes: bytes,
      fileBytes: 1024 ** 3,
      acceptedCount: 1,
      failedCount: 0,
    });
};
async function cancel(batch: Batch | undefined) {
  if (!batch || batch.done) return;
  batch.cancelled = true;
  events.push(`cancel:${batch.id}`);
  emit(64 * 1024 ** 2, batches.indexOf(batch), 'cancelling');
  await batch.result.promise;
}
const controls = {
  progress: emit,
  allowAppend: () => {
    allowAppend = true;
  },
  complete: (assetIds = ['complete-reference']) => {
    const batch = batches.at(-1);
    if (!batch) throw new Error('No batch');
    batch.done = true;
    events.push(`complete:${batch.id}`);
    batch.result.resolve({
      assetIds,
      errors: [],
      cancelled: batch.cancelled,
      cancelledCount: batch.cancelled ? 2 : 0,
    });
  },
  blockProject: (value: boolean) => {
    unavailable = value;
    setUnavailable(value);
  },
  failSaving: (value: boolean) => {
    failing = value;
  },
  holdSave: () => {
    saveGate = deferred<void>();
  },
  releaseSave: () => {
    saveGate?.resolve();
    saveGate = null;
  },
  timeout: () => leaveCancelled?.(),
  nativeResults: [] as boolean[],
  native: async () => {
    controls.nativeResults.push((await nativeSave?.()) ?? false);
  },
  home: async () => {},
  homeResult: null as boolean | null,
  sameTurnResult: null as boolean | null,
  state: () => ({
    workspace: stored,
    drafts: [...drafts.records.values()],
    unavailable,
    recoveryCalls,
    appendAttempts,
    batches: batches.map(({ id, done, cancelled }) => ({
      id,
      done,
      cancelled,
    })),
    events,
    pauses: [...pauses],
  }),
};
Object.assign(window, { importControls: controls });
window.desktop = {
  ...drafts.bridge,
  recoverWorkspaceDraft: async (...args) => {
    recoveryCalls++;
    return drafts.bridge.recoverWorkspaceDraft(...args);
  },
  getGenerationWorkspace: async () => structuredClone(stored),
  saveGenerationWorkspace: async (_project, next) => {
    events.push(`save:${next.shots[0]?.nodes.length}`);
    await saveGate?.promise;
    if (failing || unavailable) throw new Error('模拟项目保存失败');
    stored = { ...structuredClone(next), revision: next.revision + 1 };
    return structuredClone(stored);
  },
  importReferences: async (_project, requestId) => {
    const batch = {
      id: requestId,
      cancelled: false,
      done: false,
      result: deferred<ReferenceImportResult>(),
    };
    batches.push(batch);
    events.push(`start:${requestId}`);
    return batch.result.promise;
  },
  onReferenceImportProgress: (listener) => {
    progressListeners.add(listener);
    return () => progressListeners.delete(listener);
  },
  cancelReferenceImport: (requestId) =>
    cancel(batches.find((item) => item.id === requestId)),
  prepareReferenceImportsForLeave: async () => {
    const token = crypto.randomUUID();
    pauses.add(token);
    events.push(`pause:${token}`);
    await cancel(batches.findLast((item) => !item.done));
    return token;
  },
  resumeReferenceSaves: async (token) => {
    events.push(`resume:${token}`);
    pauses.delete(token);
  },
  cancelProjectHealth: async () => {},
  cancelProjectPackage: async () => {},
  cancelExportPreparation: async () => {},
  cancelStagingOperations: async () => {},
  onSaveBeforeLeave: (listener) => {
    nativeSave = listener;
    return () => {
      nativeSave = null;
    };
  },
  onLeaveCancelled: (listener) => {
    leaveCancelled = listener;
    return () => {
      leaveCancelled = null;
    };
  },
  saveViewport: async () => {},
} as DesktopBridge;

function SameTurnProbe() {
  const importer = useReferenceImport('project', () => ({
    accept: () => {
      events.push('probe:add');
      return true;
    },
    finish: () => {},
  }));
  return (
    <button
      type="button"
      id="same-turn"
      hidden
      onClick={() => {
        void importer.importFiles();
        void importer.cancelImport().then((result) => {
          controls.sameTurnResult = result;
        });
      }}
    >
      立即取消
    </button>
  );
}

function Fixture() {
  const lifecycle = useSaveLifecycle();
  const [home, setHome] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [rejectedShot, setRejectedShot] = useState(() =>
    newShot('rejected', '拒收重试', { x: 0, y: 0 }),
  );
  useEffect(() => {
    setUnavailable = setBlocked;
    return () => {
      setUnavailable = () => {};
    };
  }, []);
  useEffect(() => {
    controls.home = async () => {
      const saved = await lifecycle.prepare();
      controls.homeResult = saved;
      if (saved) setHome(true);
    };
  }, [lifecycle.prepare]);
  return (
    <>
      <SameTurnProbe />
      <div className="flex h-screen flex-col">
        {home ? (
          <p id="home">项目首页</p>
        ) : new URLSearchParams(location.search).has('reject') ? (
          <HoldFeedbackProvider>
            <MaterialCanvas
              shot={rejectedShot}
              snapshot={snapshot}
              blocked={false}
              longPressSplit={false}
              saving={false}
              error={null}
              onChange={(update) => setRejectedShot(update)}
              beginImport={() => ({
                append: (nodes) => {
                  appendAttempts.push(structuredClone([...nodes]));
                  if (!allowAppend) return false;
                  setRejectedShot((shot) => ({
                    ...shot,
                    nodes: [
                      ...shot.nodes,
                      ...nodes.map((node) => ({
                        ...node,
                        type: 'asset' as const,
                      })),
                    ],
                  }));
                  return true;
                },
                finish: () => {
                  events.push('target:finished');
                },
              })}
              onClose={() => setHome(true)}
              beforeClose={async () => true}
              retry={async () => true}
            />
          </HoldFeedbackProvider>
        ) : (
          <ProjectCanvas
            snapshot={snapshot}
            blocked={blocked}
            projectUnavailable={blocked}
            inactive={lifecycle.saving}
            interactions={defaultInteractionSettings()}
            report={() => {}}
          />
        )}
      </div>
      <SaveLifecycleStatus {...lifecycle} />
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
