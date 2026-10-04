import { StrictMode, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { EditableName } from '@/components/ui/editable-name';
import { useShotWorkspace } from '@/features/generation/use-shot-workspace';
import { useSaveLifecycle } from '@/features/lifecycle/use-save-lifecycle';
import { ProjectUnavailableNotice } from '@/features/projects/project-unavailable-notice';
import { useLibrary } from '@/features/projects/use-library';
import { AppSettings } from '@/features/settings/app-settings';
import { useCanvasDocument } from '@/features/workspace/use-canvas-document';
import { applyCanvasPatch } from '../../src/shared/canvas/model';
import type { DesktopBridge } from '../../src/shared/desktop';
import { emptyWorkspace, newShot } from '../../src/shared/generation/workspace';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type { LibraryState, ProjectSnapshot } from '../../src/shared/models';
import { appBackupMock } from './app-backup-mock';
import { referenceImportMock } from './reference-import-mock';
import { workspaceDraftMock } from './workspace-draft-mock';
import '../../src/renderer/src/styles.css';

const projectId = 'bc258d23-ac6d-403b-981a-4983fb3346ef';
const cardId = '31258d23-ac6d-403b-981a-4983fb3346ef';
const assetId = 'df258d23-ac6d-403b-981a-4983fb3346ef';
let stored: ProjectSnapshot = {
  project: { id: projectId, folder: projectId, name: '原项目', updatedAt: '' },
  viewport: { x: 0, y: 0, zoom: 1 },
  assets: [
    {
      id: assetId,
      name: 'video',
      relativePath: 'assets/videos/original.mp4',
      size: 3,
      sha256: 'a'.repeat(64),
      kind: 'video',
    },
  ],
  canvas: {
    version: 1,
    revision: 0,
    cards: [{ id: cardId, assetIds: [assetId], position: { x: 0, y: 0 } }],
  },
};
let workspace = {
  ...emptyWorkspace(),
  shots: [newShot('shot', '原镜头', { x: 0, y: 0 })],
};
let available = true;
let globalState: LibraryState = {
  root: '/original',
  projects: [stored.project],
  jobs: [],
  migration: null,
  writeBlocked: false,
  interactions: defaultInteractionSettings(),
};
let listener = () => {};
let writes = 0;
let revealed = 0;
const validate = () => {
  if (!available) throw new Error('测试项目数据库离线');
};
window.desktop = {
  ...appBackupMock(),
  ...referenceImportMock().bridge,
  ...workspaceDraftMock(() => workspace).bridge,
  getLibrary: async () => structuredClone(globalState),
  openProject: async () => {
    validate();
    return structuredClone(stored);
  },
  readProjectRecovery: async () => {
    validate();
    return { snapshot: structuredClone(stored), savedReferenceAssets: [] };
  },
  onLibraryChanged: (next) => {
    listener = next;
    return () => {
      listener = () => {};
    };
  },
  getGenerationWorkspace: async () => {
    validate();
    return structuredClone(workspace);
  },
  saveGenerationWorkspace: async (_id, value) => {
    writes++;
    validate();
    if (value.revision !== workspace.revision) throw new Error('草稿版本冲突');
    workspace = { ...structuredClone(value), revision: value.revision + 1 };
    listener();
    return structuredClone(workspace);
  },
  patchCanvas: async (_id, patch) => {
    writes++;
    validate();
    stored = { ...stored, canvas: applyCanvasPatch(stored.canvas, patch) };
    listener();
    return structuredClone(stored);
  },
  revealRoot: async () => {
    revealed++;
  },
  cancelProjectHealth: async () => {},
  cancelProjectPackage: async () => {},
  onSaveBeforeLeave: () => () => {},
  onLeaveCancelled: () => () => {},
} as DesktopBridge;

function Editor({ state }: { state: ReturnType<typeof useLibrary> }) {
  const instance = useRef(crypto.randomUUID());
  const blocked = !!state.projectUnavailable;
  const snapshot = state.project as ProjectSnapshot;
  const shots = useShotWorkspace(
    projectId,
    blocked,
    state.reportProjectFailure,
  );
  const document = useCanvasDocument(
    snapshot,
    blocked,
    state.reportProjectFailure,
    () => () => {},
  );
  const shot = shots.shots[0];
  return createPortal(
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
          name: shot?.name,
          canUndo: document.canUndo,
          shotUndo: shots.historyFor('shot').canUndo,
          x: document.snapshot.canvas.cards[0]?.position.x,
        })}
      </output>
      {shot && (
        <EditableName
          value={shot.name}
          label="镜头名称"
          disabled={blocked}
          onChange={(name) => shots.updateShot('shot', (s) => ({ ...s, name }))}
        />
      )}
      <button
        type="button"
        id="shot-edit"
        disabled={!shot || blocked}
        onClick={() =>
          shots.updateShot('shot', (s) => ({ ...s, name: '未保存镜头输入' }))
        }
      >
        Edit shot
      </button>
      <button
        type="button"
        id="shot-undo"
        onClick={() => shots.historyFor('shot').undo()}
      >
        Undo shot
      </button>
      <button
        type="button"
        id="canvas-edit"
        onClick={() => {
          const card = document.snapshot.canvas.cards[0];
          if (card)
            void document.commit({
              before: [card],
              after: [{ ...card, position: { x: card.position.x + 50, y: 0 } }],
            });
        }}
      >
        Edit canvas
      </button>
      <button type="button" id="canvas-undo" onClick={document.undo}>
        Undo canvas
      </button>
    </section>,
    window.document.body,
  );
}

function Harness() {
  const state = useLibrary();
  const lifecycle = useSaveLifecycle();
  const [settings, setSettings] = useState(false);
  const [saved, setSaved] = useState<boolean | null>(null);
  const [stats, setStats] = useState('');
  return (
    <>
      <output id="session-state">
        {JSON.stringify({
          project: state.project?.project.id,
          unavailable: state.projectUnavailable,
          root: state.library?.root,
          saved,
        })}
      </output>
      <output id="stats">{stats}</output>
      <button
        type="button"
        id="stats-refresh"
        onClick={() =>
          setStats(JSON.stringify({ writes, revealed, stored, workspace }))
        }
      >
        Stats
      </button>
      <button
        type="button"
        id="open"
        onClick={() => void state.open(projectId)}
      >
        Open
      </button>
      <button
        type="button"
        id="offline"
        onClick={() => {
          available = false;
          listener();
        }}
      >
        Offline
      </button>
      <button
        type="button"
        id="offline-silent"
        onClick={() => {
          available = false;
        }}
      >
        Offline without event
      </button>
      <button
        type="button"
        id="restore"
        onClick={() => {
          available = true;
        }}
      >
        Restore file
      </button>
      <button
        type="button"
        id="global-update"
        onClick={() => {
          globalState = { ...globalState, root: '/still-live' };
          listener();
        }}
      >
        Global status
      </button>
      <button
        type="button"
        id="different-db"
        onClick={() => {
          available = true;
          stored = {
            ...stored,
            canvas: {
              ...stored.canvas,
              cards: stored.canvas.cards.map((card) => ({
                ...card,
                position: { x: 999, y: 0 },
              })),
            },
          };
        }}
      >
        Different project copy
      </button>
      <button
        type="button"
        id="different-workspace"
        onClick={() => {
          available = true;
          workspace = { ...workspace, revision: workspace.revision + 1 };
        }}
      >
        New workspace version
      </button>
      <button
        type="button"
        id="retry"
        onClick={() => void state.retryProject()}
      >
        Retry
      </button>
      <button
        type="button"
        id="home"
        onClick={() =>
          void lifecycle.prepare().then((ok) => {
            setSaved(ok);
            if (ok) state.home();
          })
        }
      >
        Home
      </button>
      <button type="button" id="settings" onClick={() => setSettings(true)}>
        Settings
      </button>
      {state.project && <Editor state={state} />}
      {settings && state.library && (
        <AppSettings
          library={state.library}
          error={null}
          run={state.run}
          beforeMigration={() => lifecycle.prepare()}
          initialPage="storage"
          onClose={() => setSettings(false)}
        />
      )}
    </>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
