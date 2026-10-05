import { StrictMode, useEffect, useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { projectEditRecoveryGuards } from '@/features/drafts/project-edit-recovery-guards';
import { useProjectEditDrafts } from '@/features/drafts/use-project-edit-drafts';
import { useShotWorkspace } from '@/features/generation/use-shot-workspace';
import { useLibrary } from '@/features/projects/use-library';
import { SequenceTimeline } from '@/features/workspace/editor/sequence-timeline';
import { useSequenceEditor } from '@/features/workspace/editor/use-sequence-editor';
import { useCanvasDocument } from '@/features/workspace/use-canvas-document';
import {
  applyCanvasPatch,
  type CanvasPatch,
} from '../../src/shared/canvas/model';
import type { DesktopBridge } from '../../src/shared/desktop';
import { emptyWorkspace } from '../../src/shared/generation/workspace';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type { LibraryState, ProjectSnapshot } from '../../src/shared/models';
import {
  type ProjectEditDraftRecord,
  projectEditDraftState,
} from '../../src/shared/project-edit-draft';
import { projectEditDraftMock } from './project-edit-draft-mock';
import { projectPackageMock } from './project-package-mock';
import { workspaceDraftMock } from './workspace-draft-mock';
import '../../src/renderer/src/styles.css';

const projectId = 'af973c92-408c-4965-8267-08b8b46a7a4a';
const assetId = 'b856a683-78f5-4bc1-a015-f2c8a839a6dd';
const original: ProjectSnapshot = {
  project: {
    id: projectId,
    folder: projectId,
    name: '裁剪恢复交互',
    updatedAt: '',
  },
  viewport: { x: 0, y: 0, zoom: 1 },
  canvas: {
    version: 1,
    revision: 0,
    cards: [{ id: assetId, assetIds: [assetId], position: { x: 100, y: 100 } }],
  },
  assets: [
    {
      id: assetId,
      name: '测试视频',
      relativePath: `assets/videos/${assetId}.mp4`,
      kind: 'video',
      size: 100,
      sha256: 'a'.repeat(64),
    },
  ],
};
let remote = structuredClone(original);
let workspace = emptyWorkspace();
const library: LibraryState = {
  root: '/fixture',
  projects: [remote.project],
  jobs: [],
  migration: null,
  writeBlocked: false,
  interactions: defaultInteractionSettings(),
};
const journal = projectEditDraftMock(() => remote);
const { records } = journal;
let notify = () => {};
let hold = false;
let pending: { patch: CanvasPatch; reject: (error: Error) => void } | null =
  null;
let writes = 0;
let gestures = 0;
let loseRecoveryReply = false;
let rejectRecoveryBeforeWrite = false;
let controls: {
  save: (end: number) => void;
  undo: () => void;
  retry: () => Promise<boolean>;
  explicit: (loseReply?: boolean | 'before' | 'noop') => Promise<boolean>;
  gesture: (active: boolean) => void;
  lock: () => () => void;
} | null = null;

window.desktop = {
  ...projectPackageMock().bridge,
  ...workspaceDraftMock(() => workspace).bridge,
  ...journal.bridge,
  getLibrary: async () => structuredClone(library),
  openProject: async () => structuredClone(remote),
  readProjectRecovery: async () => ({
    snapshot: structuredClone(remote),
    savedReferenceAssets: [],
  }),
  onLibraryChanged: (listener) => {
    notify = listener;
    return () => {
      notify = () => {};
    };
  },
  getGenerationWorkspace: async () => structuredClone(workspace),
  listProjectEditDrafts: async () => ({
    drafts: structuredClone([...records.values()]),
    issues: [],
  }),
  recoverProjectEditDraft: async (_id, key) => {
    const record = records.get(key.sessionId);
    if (record?.kind !== 'trim' || record.seq !== key.seq)
      throw new Error('Missing exact explicit trim recovery record');
    if (rejectRecoveryBeforeWrite) {
      rejectRecoveryBeforeWrite = false;
      throw new Error('测试旧裁剪在写入前失败，原项目未变');
    }
    if (projectEditDraftState(record, remote) !== 'submitted')
      remote = {
        ...remote,
        canvas: applyCanvasPatch(remote.canvas, {
          before: [record.baseline],
          after: [record.target],
        }),
      };
    if (!(await journal.bridge.acknowledgeProjectEditDraft(projectId, key)))
      throw new Error('Explicit native trim was not acknowledged');
    notify();
    if (loseRecoveryReply) {
      loseRecoveryReply = false;
      throw new Error('测试旧裁剪已提交并清理，但 IPC 回执丢失');
    }
    return structuredClone(remote);
  },
  patchCanvas: async (_id, patch) => {
    writes++;
    if (hold) {
      hold = false;
      return new Promise((_resolve, reject) => {
        pending = { patch: structuredClone(patch), reject };
      });
    }
    remote = { ...remote, canvas: applyCanvasPatch(remote.canvas, patch) };
    notify();
    return structuredClone(remote);
  },
} as DesktopBridge;

const fixture = {
  state: () =>
    structuredClone({
      remote,
      workspace,
      records: [...records.values()],
      writes,
      pending: !!pending,
      gestures,
    }),
  holdNext: () => {
    hold = true;
  },
  save: (end: number) => controls?.save(end),
  loseReply: () => {
    if (!pending) throw new Error('No write is pending');
    remote = {
      ...remote,
      canvas: applyCanvasPatch(remote.canvas, pending.patch),
    };
    notify();
    pending.reject(new Error('测试裁剪已提交但 IPC 回执丢失'));
    pending = null;
  },
  conflictShot: (active: boolean) => {
    workspace = { ...emptyWorkspace(), revision: active ? 1 : 0 };
  },
  retry: () => controls?.retry(),
  explicit: (loseReply?: boolean | 'before' | 'noop') =>
    controls?.explicit(loseReply),
  lockGestureTest: () => {
    if (!controls) throw new Error('Editor not loaded');
    controls.gesture(true);
    let rejected = false;
    try {
      controls.lock()();
    } catch {
      rejected = true;
    }
    controls.gesture(false);
    const release = controls.lock();
    controls.save(3);
    controls.gesture(true);
    const element = document.querySelector<HTMLElement>(
      'button[aria-label="片段终点"]',
    );
    if (!element) throw new Error('Missing real timeline handle');
    element.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerId: 99,
        clientX: 350,
        clientY: 160,
      }),
    );
    release();
    return { rejected, gestures };
  },
};
Object.assign(window, { trimRecoveryFixture: fixture });

function Editor({ state }: { state: ReturnType<typeof useLibrary> }) {
  const recovery = useProjectEditDrafts(
    projectId,
    !!state.projectUnavailable,
    async (_record, saved) => state.refreshProjectAfterEdit(saved),
  );
  const blocked = !!state.projectUnavailable || recovery.restoring;
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
  const card = canvas.snapshot.canvas.cards[0];
  if (!card) throw new Error('Missing fixture card');
  const frames = useRef(
    new Map([[assetId, { width: 160, height: 90, duration: 10 }]]),
  );
  const editor = useSequenceEditor({
    card,
    assets: canvas.snapshot.assets,
    projectId,
    projectName: remote.project.name,
    blocked,
    saving: canvas.saving,
    shortcuts: library.interactions.shortcuts,
    canUndo: canvas.canUndoTrim,
    canRedo: canvas.canRedoTrim,
    undo: canvas.undo,
    redo: canvas.redo,
    commit: canvas.commit,
    trimRecovery: canvas.trimRecovery,
    onClose: () => {},
    frames: frames.current,
  });
  const current = useRef({ canvas, editor });
  current.current = { canvas, editor };
  useLayoutEffect(
    () =>
      projectEditRecoveryGuards.register(
        projectId,
        () => current.current.canvas.canRecoverProjectEdits(),
        (record, saved) =>
          current.current.canvas.acceptRecoveredEdit(record, saved),
        (record) => current.current.canvas.prepareRecoveredEdit(record),
      ),
    [],
  );
  useEffect(() => {
    controls = {
      save: (end) => editor.save(0, { start: 1, end }),
      undo: canvas.undo,
      retry: state.retryProject,
      gesture: editor.setGesturing,
      lock: () => projectEditRecoveryGuards.begin(projectId),
      explicit: async (loseReply = false) => {
        const before = remote.canvas.cards[0];
        if (!before) throw new Error('Missing fixture card');
        const target =
          loseReply === 'noop'
            ? before
            : { ...before, trims: { [assetId]: { start: 1, end: 3 } } };
        const record: ProjectEditDraftRecord = [...records.values()].find(
          (draft) => draft.kind === 'trim',
        ) ?? {
          kind: 'trim',
          sessionId: crypto.randomUUID(),
          seq: 1,
          baseline: structuredClone(before),
          target,
          assets: remote.assets,
          format: 'infinite-afflatus-project-edit-draft',
          version: 1,
          project: remote.project,
          updatedAt: '',
        };
        records.set(record.sessionId, record);
        loseRecoveryReply = loseReply === true || loseReply === 'noop';
        rejectRecoveryBeforeWrite = loseReply === 'before';
        return recovery.recover(record);
      },
    };
  });
  return (
    <section>
      <output id="state">
        {JSON.stringify({
          canvas: canvas.snapshot.canvas,
          undo: canvas.canUndo,
          redo: canvas.canRedo,
          pending: editor.pending,
          error: editor.saveError,
          trimError: canvas.trimRecoveryError,
          queueEnd: editor.clips[0]?.range.end,
          unavailable: state.projectUnavailable,
          recoveryError: recovery.error,
          loaded: shots.loaded,
          canRecover: canvas.canRecoverProjectEdits(),
          gesturing: editor.gesturing,
        })}
      </output>
      <button
        type="button"
        id="undo"
        onClick={canvas.undo}
        disabled={!canvas.canUndo || blocked || editor.pending}
      >
        撤销
      </button>
      <SequenceTimeline
        projectId={projectId}
        clips={editor.clips}
        frames={frames.current}
        time={0}
        playingIndex={0}
        selected={0}
        disabled={blocked || editor.pending}
        reset={editor.reset}
        zoom={1}
        onSelect={() => {}}
        onSeek={() => {}}
        onPreview={editor.preview}
        onCommit={editor.save}
        onCancel={editor.cancel}
        onGesture={(active) => {
          if (active) gestures++;
          editor.setGesturing(active);
        }}
      />
    </section>
  );
}
function Harness() {
  const state = useLibrary();
  return (
    <>
      <button
        type="button"
        id="open"
        onClick={() => void state.open(projectId)}
      >
        打开
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
