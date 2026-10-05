import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HoldFeedbackProvider } from '@/components/canvas/hold-feedback';
import { MaterialCanvas } from '@/features/generation/material-canvas';
import { SaveLifecycleStatus } from '@/features/lifecycle/save-lifecycle-status';
import { usePendingSave } from '@/features/lifecycle/use-pending-save';
import { useSaveLifecycle } from '@/features/lifecycle/use-save-lifecycle';
import { ProjectHome } from '@/features/projects/project-home';
import { ProjectPackageActions } from '@/features/projects/project-package-actions';
import { useLibrary } from '@/features/projects/use-library';
import type { DesktopBridge } from '../../src/shared/desktop';
import { newShot } from '../../src/shared/generation/workspace';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type { LibraryState, ProjectSnapshot } from '../../src/shared/models';
import type {
  ProjectPackageInfo,
  ProjectPackageOperation,
  ProjectPackageProgress,
} from '../../src/shared/project-package';
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
const id = 'bc258d23-ac6d-403b-981a-4983fb3346ef';
const original: ProjectSnapshot = {
  project: { id, folder: id, name: '原项目', updatedAt: '' },
  viewport: { x: 0, y: 0, zoom: 1 },
  assets: [],
  canvas: { version: 1, revision: 0, cards: [] },
};
const library: LibraryState = {
  root: '/fixture/projects',
  projects: [original.project],
  jobs: [],
  migration: null,
  writeBlocked: false,
  interactions: defaultInteractionSettings(),
};
type Value = ProjectPackageInfo | ProjectSnapshot | string | null;
type Request = {
  id: string;
  kind: ProjectPackageOperation;
  result: ReturnType<typeof deferred<Value>>;
  done: boolean;
};
const requests: Request[] = [];
const listeners = new Set<(progress: ProjectPackageProgress) => void>();
const pauses = new Set<string>();
const released: string[] = [];
const referencePauses = new Set<string>();
const pauseReplies: {
  token: string;
  reply: ReturnType<typeof deferred<void>>;
}[] = [];
const events: string[] = [];
let holdCancellation = false;
let holdPause = false;
let flushHold: ReturnType<typeof deferred<boolean>> | null = null;
let flushFailure = false;
let savedText = '';
let nativeSave: (() => Promise<boolean>) | null = null;
let timeout: (() => void) | null = null;
const closeResults: boolean[] = [];
const homeResults: boolean[] = [];
let showActions: (value: boolean) => void = () => {};
let showMaterial: (value: boolean) => void = () => {};
let edit: (value: string) => void = () => {};

function progress(index: number, values: Partial<ProjectPackageProgress>) {
  const request = requests[index];
  if (!request) throw new Error('Missing package request');
  const value: ProjectPackageProgress = {
    requestId: request.id,
    projectId: request.kind === 'import' ? null : id,
    operation: request.kind,
    phase: 'copying',
    completedBytes: 256 * 1024,
    totalBytes: 1024 * 1024,
    completedFiles: 1,
    totalFiles: 3,
    fileName: '参考视频.mp4',
    canCancel: true,
    ...values,
  };
  for (const listener of listeners) listener(value);
}
function finish(
  index: number,
  outcome: 'success' | 'cancel' | 'error' = 'success',
) {
  const request = requests[index];
  if (!request || request.done) return;
  request.done = true;
  events.push(`finish:${request.id}:${outcome}`);
  if (outcome === 'error') {
    request.result.reject(new Error('临时文件清理失败，请保留文件并重试'));
  } else if (outcome === 'cancel') request.result.resolve(null);
  else if (request.kind === 'inspect')
    request.result.resolve({
      projectId: id,
      name: '原项目',
      assetCount: 2,
      bytes: 1024 * 1024,
    });
  else if (request.kind === 'export')
    request.result.resolve('/fixture/作品.afflatus');
  else
    request.result.resolve({
      ...original,
      project: {
        ...original.project,
        id: `copy-${index}`,
        folder: `copy-${index}`,
        name: '独立新项目',
      },
    });
}
function begin(kind: ProjectPackageOperation, requestId: string) {
  if (pauses.size) return Promise.resolve(null);
  const request: Request = {
    id: requestId,
    kind,
    done: false,
    result: deferred<Value>(),
  };
  requests.push(request);
  events.push(`start:${kind}:${requestId}`);
  progress(requests.length - 1, {
    phase: kind === 'inspect' ? 'preparing' : 'choosing',
    completedBytes: 0,
    totalBytes: null,
    totalFiles: null,
    fileName: null,
  });
  return request.result.promise;
}
async function cancel(requestId?: string) {
  const active = requests.filter(
    (request) => !request.done && (!requestId || request.id === requestId),
  );
  for (const request of active) {
    events.push(`cancel:${request.id}`);
    progress(requests.indexOf(request), {
      phase: 'cancelling',
      canCancel: false,
    });
    if (!holdCancellation) finish(requests.indexOf(request), 'cancel');
  }
  await Promise.all(active.map((request) => request.result.promise));
}
const bridge: Pick<
  DesktopBridge,
  | 'getLibrary'
  | 'openProject'
  | 'readProjectRecovery'
  | 'onLibraryChanged'
  | 'inspectProjectPackage'
  | 'exportProjectPackage'
  | 'importProjectPackage'
  | 'duplicateProject'
  | 'cancelProjectPackage'
  | 'onProjectPackageProgress'
  | 'preparePackageOperationsForLeave'
  | 'resumePackageOperations'
  | 'prepareReferenceImportsForLeave'
  | 'resumeReferenceSaves'
  | 'cancelProjectHealth'
  | 'cancelExportPreparation'
  | 'cancelStagingOperations'
  | 'onSaveBeforeLeave'
  | 'onLeaveCancelled'
  | 'onReferenceImportProgress'
  | 'cancelReferenceImport'
  | 'importReferences'
> = {
  getLibrary: async () => structuredClone(library),
  openProject: async () => structuredClone(original),
  readProjectRecovery: async () => ({
    snapshot: structuredClone(original),
    savedReferenceAssets: [],
  }),
  onLibraryChanged: () => () => {},
  onReferenceImportProgress: () => () => {},
  cancelReferenceImport: async () => {},
  importReferences: async () => ({
    assetIds: [],
    errors: [],
    cancelled: true,
    cancelledCount: 0,
  }),
  inspectProjectPackage: (projectId, requestId) => {
    if (projectId !== id) throw new Error('Wrong project');
    return begin('inspect', requestId) as Promise<ProjectPackageInfo | null>;
  },
  exportProjectPackage: (_projectId, requestId) =>
    begin('export', requestId) as Promise<string | null>,
  importProjectPackage: (requestId) =>
    begin('import', requestId) as Promise<ProjectSnapshot | null>,
  duplicateProject: (_projectId, requestId) =>
    begin('duplicate', requestId) as Promise<ProjectSnapshot | null>,
  cancelProjectPackage: cancel,
  onProjectPackageProgress: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  preparePackageOperationsForLeave: async () => {
    const token = crypto.randomUUID();
    pauses.add(token);
    events.push(`pause:${token}`);
    const reply = deferred<void>();
    pauseReplies.push({ token, reply });
    if (!holdPause) reply.resolve();
    await cancel();
    await reply.promise;
    return token;
  },
  resumePackageOperations: async (token) => {
    released.push(token);
    pauses.delete(token);
  },
  prepareReferenceImportsForLeave: async () => {
    const token = crypto.randomUUID();
    referencePauses.add(token);
    return token;
  },
  resumeReferenceSaves: async (token) => {
    referencePauses.delete(token);
  },
  cancelProjectHealth: async () => {},
  cancelExportPreparation: async () => {},
  cancelStagingOperations: async () => {},
  onSaveBeforeLeave: (listener) => {
    nativeSave = listener;
    return () => {
      nativeSave = null;
    };
  },
  onLeaveCancelled: (listener) => {
    timeout = listener;
    return () => {
      timeout = null;
    };
  },
};
Object.assign(window, {
  desktop: bridge,
  packageControls: {
    state: () => ({
      requests: requests.map(({ id, kind, done }) => ({ id, kind, done })),
      events,
      pauses: [...pauses],
      released,
      referencePauses: [...referencePauses],
      closeResults,
      homeResults,
      savedText,
      listeners: listeners.size,
    }),
    progress,
    finish,
    holdCancellation: (value: boolean) => {
      holdCancellation = value;
    },
    holdFlush: () => {
      flushHold = deferred<boolean>();
    },
    resolveFlush: () => {
      flushHold?.resolve(true);
      flushHold = null;
    },
    failFlush: (value: boolean) => {
      flushFailure = value;
    },
    edit: (value: string) => edit(value),
    nativeClose: () => {
      if (!nativeSave) throw new Error('No native save listener');
      void nativeSave().then((value) => closeResults.push(value));
    },
    timeout: () => timeout?.(),
    holdPause: (value: boolean) => {
      holdPause = value;
    },
    releasePause: (index: number) => pauseReplies[index]?.reply.resolve(),
    show: (value: boolean) => showActions(value),
    material: (value: boolean) => showMaterial(value),
  },
});

function Fixture() {
  const state = useLibrary();
  const lifecycle = useSaveLifecycle();
  const [text, setText] = useState('未保存的创作');
  const [visible, setVisible] = useState(true);
  const [material, setMaterial] = useState(false);
  const [shot, setShot] = useState(() =>
    newShot('shot', '项目包测试镜头', { x: 0, y: 0 }),
  );
  showActions = setVisible;
  showMaterial = setMaterial;
  edit = setText;
  usePendingSave('项目包回归文字', async () => {
    events.push(`flush:${text}`);
    if (flushHold) await flushHold.promise;
    if (flushFailure) return false;
    savedText = text;
    return true;
  });
  return (
    <div className="h-screen overflow-auto p-5">
      <div inert={lifecycle.saving}>
        <textarea
          aria-label="创作文字"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="button"
          onClick={() =>
            void lifecycle.prepare().then((saved) => {
              homeResults.push(saved);
              if (saved) state.home();
            })
          }
        >
          返回首页
        </button>
        <output data-project>{state.project?.project.name ?? '首页'}</output>
        {state.error && <p role="alert">{state.error}</p>}
        {visible && state.project && (
          <ProjectPackageActions
            key={state.project.project.id}
            projectId={state.project.project.id}
            projectName={state.project.project.name}
            report={state.report}
          />
        )}
        {!state.project && state.library && (
          <ProjectHome
            projects={state.library.projects}
            disabled={state.busy}
            onCreate={async () => {}}
            onOpen={state.open}
            onImport={state.importPackage}
            packageImport={state.packageImport}
          />
        )}
      </div>
      <SaveLifecycleStatus {...lifecycle} />
      {material && (
        <HoldFeedbackProvider>
          <MaterialCanvas
            shot={shot}
            snapshot={original}
            blocked={false}
            saving={false}
            error={null}
            longPressSplit={false}
            onChange={(update) => setShot(update)}
            onClose={() => setMaterial(false)}
            beforeClose={async () => {
              events.push('material:closed');
              return true;
            }}
            retry={async () => true}
          />
        </HoldFeedbackProvider>
      )}
    </div>
  );
}
createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
