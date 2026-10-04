import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { useShotWorkspace } from '@/features/generation/use-shot-workspace';
import { ProjectUnavailableNotice } from '@/features/projects/project-unavailable-notice';
import { useLibrary } from '@/features/projects/use-library';
import { useCanvasDocument } from '@/features/workspace/use-canvas-document';
import { applyCanvasPatch } from '../../src/shared/canvas/model';
import type { DesktopBridge } from '../../src/shared/desktop';
import { emptyWorkspace, newShot } from '../../src/shared/generation/workspace';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type {
  Asset,
  LibraryState,
  ProjectSnapshot,
} from '../../src/shared/models';
import { workspaceDraftMock } from './workspace-draft-mock';
import '../../src/renderer/src/styles.css';

const projectId = 'bc258d23-ac6d-403b-981a-4983fb3346ef';
const existing = new URLSearchParams(location.search).has('existing');
const originalAsset: Asset = {
  id: 'df258d23-ac6d-403b-981a-4983fb3346ef',
  name: '原视频',
  relativePath: 'assets/videos/original.mp4',
  size: 3,
  sha256: 'a'.repeat(64),
  kind: 'video',
};
const references: Asset[] = ['first', 'second'].map((name, index) => ({
  id: name,
  name: `${name}.txt`,
  relativePath: `assets/text/${name}.txt`,
  size: 8 + index,
  sha256: String(index + 1).repeat(64),
  kind: 'text',
  usage: 'reference',
}));
let remote: ProjectSnapshot = {
  project: {
    id: projectId,
    folder: projectId,
    name: '恢复测试项目',
    updatedAt: '',
  },
  viewport: { x: 0, y: 0, zoom: 1 },
  assets: existing ? [originalAsset] : [],
  canvas: {
    version: 1,
    revision: 0,
    cards: existing
      ? [
          {
            id: '31258d23-ac6d-403b-981a-4983fb3346ef',
            assetIds: [originalAsset.id],
            position: { x: 0, y: 0 },
          },
        ]
      : [],
  },
};
let workspace = {
  ...emptyWorkspace(),
  shots: [newShot('shot', '原镜头', { x: 0, y: 0 })],
};
let library: LibraryState = {
  root: '/fixture-projects',
  projects: [remote.project],
  jobs: [],
  migration: null,
  writeBlocked: false,
  interactions: defaultInteractionSettings(),
};
let available = true;
let notify = () => {};
let savedReferences: Asset[] = [];
let originalDatabase: ProjectSnapshot | null = null;
let recoveryReads = 0;
let writes = 0;
const validate = () => {
  if (!available) throw new Error('模拟项目数据库离线');
};
window.desktop = {
  ...workspaceDraftMock(() => workspace).bridge,
  getLibrary: async () => structuredClone(library),
  openProject: async () => {
    validate();
    return structuredClone(remote);
  },
  readProjectRecovery: async () => {
    recoveryReads++;
    validate();
    // One native reply captures both views together; never compose proof from getLibrary in the UI.
    return structuredClone({
      snapshot: remote,
      savedReferenceAssets: savedReferences,
    });
  },
  onLibraryChanged: (listener) => {
    notify = listener;
    return () => {
      notify = () => {};
    };
  },
  getGenerationWorkspace: async () => {
    validate();
    return structuredClone(workspace);
  },
  saveGenerationWorkspace: async (_id, input) => {
    validate();
    if (input.revision !== workspace.revision) throw new Error('镜头版本冲突');
    writes++;
    workspace = { ...structuredClone(input), revision: input.revision + 1 };
    notify();
    return structuredClone(workspace);
  },
  patchCanvas: async (_id, patch) => {
    validate();
    writes++;
    remote = { ...remote, canvas: applyCanvasPatch(remote.canvas, patch) };
    notify();
    return structuredClone(remote);
  },
} as DesktopBridge;
const controls = {
  saveReferencesThenLoseProject: (count: number) => {
    savedReferences = structuredClone(references.slice(0, count));
    remote = { ...remote, assets: [...remote.assets, ...savedReferences] };
    library = {
      ...library,
      jobs: savedReferences.map((asset) => ({
        id: asset.id,
        projectId,
        resultKey: `reference:${asset.id}`,
        name: asset.name,
        kind: asset.kind,
        usage: 'reference' as const,
        extension: 'txt',
        status: 'saved' as const,
        size: asset.size,
        sha256: asset.sha256,
        error: null,
        createdAt: '',
        outputRelativePath: asset.relativePath,
      })),
    };
    originalDatabase = structuredClone(remote);
    // The real library-change debounce has not had an opportunity to publish the new assets.
    notify();
    available = false;
    window.dispatchEvent(new Event('focus'));
  },
  restore: (
    variant: 'original' | 'missing-second' | 'changed-asset' | 'changed-canvas',
  ) => {
    if (!originalDatabase) throw new Error('Project has not gone offline');
    remote = structuredClone(originalDatabase);
    if (variant === 'missing-second')
      remote.assets = remote.assets.filter((asset) => asset.id !== 'second');
    if (variant === 'changed-asset')
      remote.assets = remote.assets.map((asset) =>
        asset.id === originalAsset.id
          ? { ...asset, sha256: 'f'.repeat(64) }
          : asset,
      );
    if (variant === 'changed-canvas')
      remote.canvas = {
        ...remote.canvas,
        cards: remote.canvas.cards.map((card) => ({
          ...card,
          position: { x: 999, y: 0 },
        })),
      };
    available = true;
  },
  state: () =>
    structuredClone({
      remote,
      workspace,
      savedReferences,
      recoveryReads,
      writes,
    }),
};
Object.assign(window, { canvasRecoveryControls: controls });

function Editor({ state }: { state: ReturnType<typeof useLibrary> }) {
  const instance = useRef(crypto.randomUUID());
  const blocked = !!state.projectUnavailable;
  const shots = useShotWorkspace(
    projectId,
    blocked,
    state.reportProjectFailure,
  );
  const canvas = useCanvasDocument(
    state.project as ProjectSnapshot,
    blocked,
    state.reportProjectFailure,
    () => () => {},
  );
  const shot = shots.shots[0];
  return (
    <section id="editor" data-instance={instance.current}>
      {state.projectUnavailable && (
        <ProjectUnavailableNotice
          state={state.projectUnavailable}
          retry={state.retryProject}
          migrating={false}
          openSettings={() => {}}
        />
      )}
      <output id="editor-state">
        {JSON.stringify({
          assets: canvas.snapshot.assets,
          canvas: canvas.snapshot.canvas,
          shotName: shot?.name,
          shotUndo: shots.historyFor('shot').canUndo,
          canvasUndo: canvas.canUndo,
        })}
      </output>
      <button
        type="button"
        id="edit-shot"
        disabled={!shot || blocked}
        onClick={() =>
          shots.updateShot('shot', (current) => ({
            ...current,
            name: '保留的镜头编辑',
          }))
        }
      >
        编辑镜头
      </button>
      <button
        type="button"
        id="undo-shot"
        disabled={blocked}
        onClick={() => shots.historyFor('shot').undo()}
      >
        撤销镜头
      </button>
      <button
        type="button"
        id="edit-canvas"
        disabled={blocked}
        onClick={() => {
          const card = canvas.snapshot.canvas.cards[0];
          if (card)
            void canvas.commit({
              before: [card],
              after: [{ ...card, position: { x: 50, y: 0 } }],
            });
        }}
      >
        移动视频卡片
      </button>
      <button
        type="button"
        id="undo-canvas"
        disabled={blocked}
        onClick={canvas.undo}
      >
        撤销画布
      </button>
    </section>
  );
}
function Harness() {
  const state = useLibrary();
  useEffect(() => {
    Object.assign(window, { canvasRecoverySession: state });
  }, [state]);
  return (
    <>
      <output id="session-state">
        {JSON.stringify({ unavailable: state.projectUnavailable })}
      </output>
      <button
        type="button"
        id="open"
        onClick={() => void state.open(projectId)}
      >
        打开测试项目
      </button>
      {state.project && <Editor state={state} />}
    </>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
