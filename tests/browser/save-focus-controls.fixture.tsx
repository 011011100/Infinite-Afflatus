import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { HoldFeedbackProvider } from '@/components/canvas/hold-feedback';
import { Modal } from '@/components/ui/modal';
import { MaterialCanvas } from '@/features/generation/material-canvas';
import { useShotWorkspace } from '@/features/generation/use-shot-workspace';
import { SaveLifecycleStatus } from '@/features/lifecycle/save-lifecycle-status';
import { usePendingSave } from '@/features/lifecycle/use-pending-save';
import { useSaveLifecycle } from '@/features/lifecycle/use-save-lifecycle';
import type { DesktopBridge } from '../../src/shared/desktop';
import { emptyWorkspace, newShot } from '../../src/shared/generation/workspace';
import type { ProjectSnapshot } from '../../src/shared/models';
import { referenceImportMock } from './reference-import-mock';
import { workspaceDraftMock } from './workspace-draft-mock';
import '../../src/renderer/src/styles.css';

const shot = newShot('shot', '焦点测试', { x: 0, y: 0 });
shot.nodes = [
  {
    id: 'first',
    type: 'text',
    text: '第一段待保存文字',
    position: { x: 80, y: 140 },
  },
  {
    id: 'second',
    type: 'text',
    text: '第二段独立文字',
    position: { x: 520, y: 140 },
  },
];
let stored = { ...emptyWorkspace(), shots: [shot] };
let notify = () => {};
let nativeClose: (() => Promise<boolean>) | null = null;
let cancelClose: (() => void) | null = null;
const results: { id: number; saved: boolean }[] = [];
let requestId = 0;
async function requestNativeSave() {
  if (!nativeClose) throw new Error('Native save listener missing');
  const id = ++requestId;
  const saved = await nativeClose();
  results.push({ id, saved });
  notify();
  return { id, saved };
}
type SaveGate = {
  id: number;
  phase: 'flush' | 'capture' | 'modal';
  immediate: boolean | undefined;
  started: boolean;
  settled: boolean;
  promise: Promise<boolean>;
  resolve: (saved: boolean) => void;
};
const gates: SaveGate[] = [];
function hold(phase: SaveGate['phase'] = 'flush', immediate?: boolean) {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const gate = {
    id: gates.length + 1,
    phase,
    immediate,
    started: false,
    settled: false,
    promise,
    resolve,
  };
  gates.push(gate);
  return gate.id;
}
function takeGate(phase: SaveGate['phase']) {
  const gate = gates.find(
    (item) => item.phase === phase && !item.started && !item.settled,
  );
  if (!gate) return null;
  gate.started = true;
  if (gate.immediate !== undefined) {
    gate.settled = true;
    gate.resolve(gate.immediate);
  }
  notify();
  return gate.promise;
}
const bridge: Pick<
  DesktopBridge,
  | 'getGenerationWorkspace'
  | 'saveGenerationWorkspace'
  | 'onSaveBeforeLeave'
  | 'onLeaveCancelled'
  | 'cancelProjectHealth'
  | 'cancelExportPreparation'
> = {
  getGenerationWorkspace: async () => structuredClone(stored),
  saveGenerationWorkspace: async (_projectId, next) => {
    if (stored.revision !== next.revision)
      throw new Error('Fixture revision conflict');
    stored = { ...structuredClone(next), revision: stored.revision + 1 };
    return structuredClone(stored);
  },
  onSaveBeforeLeave: (listener) => {
    nativeClose = listener;
    return () => {
      nativeClose = null;
    };
  },
  onLeaveCancelled: (listener) => {
    cancelClose = listener;
    return () => {
      cancelClose = null;
    };
  },
  cancelProjectHealth: async () => {},
  cancelExportPreparation: async () => {},
};
Object.assign(window, {
  desktop: {
    ...referenceImportMock().bridge,
    ...workspaceDraftMock(() => stored).bridge,
    ...bridge,
  },
});
const snapshot: ProjectSnapshot = {
  project: {
    id: 'focus-project',
    folder: 'focus-project',
    name: '焦点测试',
    updatedAt: '',
  },
  assets: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  canvas: { version: 1, revision: 0, cards: [] },
};

function Fixture() {
  const lifecycle = useSaveLifecycle();
  const shots = useShotWorkspace(snapshot.project.id, false);
  const [outside, setOutside] = useState(false);
  const [modal, setModal] = useState(false);
  const [modalText, setModalText] = useState('原生弹窗中待保存的输入');
  const guardedModal = useRef(false);
  const preventModalEscape = useRef(false);
  const [, render] = useState(0);
  const opened = useRef(false);
  useEffect(() => {
    if (shots.loaded && !opened.current) {
      opened.current = true;
      shots.open('shot');
    }
  }, [shots.loaded, shots.open]);
  // This independent editor's delayed result keeps the actual shared save pass
  // open. Material text still uses the real workspace queue and durable journal.
  usePendingSave(
    'fixture delayed independent editor',
    async () => (await takeGate('flush')) ?? true,
    -100,
    () => takeGate('capture'),
  );
  useLayoutEffect(() => {
    notify = () => render((value) => value + 1);
    Object.assign(window, {
      saveFocus: {
        hold,
        holdCapture: () => hold('capture'),
        holdFastFailure: () => hold('flush', false),
        holdModal: () => hold('modal'),
        state: () => ({
          saving: lifecycle.saving,
          error: lifecycle.error,
          active: shots.activeId,
          current: shots.shots[0],
          stored,
          modalText,
          results,
          gates: gates.map(({ id, phase, started, settled }) => ({
            id,
            phase,
            started,
            settled,
          })),
        }),
        resolve: (id: number, saved: boolean) => {
          const gate = gates.find((item) => item.id === id);
          if (!gate?.started || gate.settled)
            throw new Error('Invalid fixture save release');
          gate.settled = true;
          gate.resolve(saved);
        },
        native: () => {
          void requestNativeSave();
          return requestId;
        },
        nativeAndWait: requestNativeSave,
        timeout: () => {
          if (!cancelClose) throw new Error('Native timeout listener missing');
          cancelClose();
        },
        remove: (id: string) =>
          shots.updateShot('shot', (current) => ({
            ...current,
            nodes: current.nodes.filter((node) => node.id !== id),
          })),
        outside: setOutside,
        modal: setModal,
        guardedModal: () => {
          guardedModal.current = true;
          setModal(true);
        },
        preventModalEscape: (prevent: boolean) => {
          preventModalEscape.current = prevent;
        },
      },
    });
  });
  return (
    <>
      <button id="root-home" type="button">
        底层项目页面
      </button>
      {shots.activeShot && (
        <MaterialCanvas
          shot={shots.activeShot}
          snapshot={snapshot}
          blocked={false}
          longPressSplit
          saving={shots.saving}
          error={shots.error}
          history={shots.historyFor('shot')}
          onChange={(update, options) =>
            shots.updateShot('shot', update, options)
          }
          onClose={shots.dismiss}
          beforeClose={shots.flush}
          retry={shots.retry}
        />
      )}
      {modal && (
        <Modal
          title="保存焦点测试弹窗"
          onClose={() => setModal(false)}
          {...(guardedModal.current
            ? { beforeClose: () => takeGate('modal') ?? Promise.resolve(true) }
            : {})}
        >
          <label>
            原生弹窗输入
            <input
              id="modal-input"
              value={modalText}
              onChange={(event) => setModalText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && preventModalEscape.current)
                  event.preventDefault();
              }}
            />
          </label>
        </Modal>
      )}
      {outside &&
        createPortal(
          <aside
            style={{ position: 'fixed', bottom: 12, right: 12, zIndex: 100 }}
          >
            <button id="other-surface" type="button">
              另一个可用面板
            </button>
          </aside>,
          document.body,
        )}
      <SaveLifecycleStatus {...lifecycle} />
    </>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <StrictMode>
    <HoldFeedbackProvider>
      <Fixture />
    </HoldFeedbackProvider>
  </StrictMode>,
);
