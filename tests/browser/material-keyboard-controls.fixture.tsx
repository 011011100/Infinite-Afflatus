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
import { MaterialCanvas } from '@/features/generation/material-canvas';
import { useShotWorkspace } from '@/features/generation/use-shot-workspace';
import type { DesktopBridge } from '../../src/shared/desktop';
import {
  emptyWorkspace,
  groupMaterials,
  newShot,
} from '../../src/shared/generation/workspace';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type {
  ShortcutAction,
  Shortcuts,
} from '../../src/shared/interaction/shortcuts';
import type { ProjectSnapshot } from '../../src/shared/models';
import { referenceImportMock } from './reference-import-mock';
import { workspaceDraftMock } from './workspace-draft-mock';
import '../../src/renderer/src/styles.css';

const shot = newShot('shot', '键盘镜头', { x: 0, y: 0 });
shot.nodes = [
  { id: 'solo', type: 'text', text: '独立文字', position: { x: 60, y: 430 } },
  {
    id: 'child-a',
    type: 'text',
    text: '组内文字甲',
    position: { x: 420, y: 130 },
  },
  {
    id: 'child-b',
    type: 'text',
    text: '组内文字乙',
    position: { x: 720, y: 130 },
  },
];
shot.labels = [
  {
    id: 'pinned',
    name: '固定标签',
    color: '#336699',
    pinned: true,
    position: { x: 440, y: 650 },
  },
  {
    id: 'far',
    name: '远处标签',
    color: '#995533',
    pinned: false,
    position: { x: 1900, y: 1400 },
  },
];
const initial = groupMaterials(shot, ['child-a', 'child-b'], 'group');
let stored = { ...emptyWorkspace(), shots: [initial] };
let writes = 0;
let notify = () => {};
const draftMock = workspaceDraftMock(() => stored);
const workspaceBridge: Pick<
  DesktopBridge,
  'getGenerationWorkspace' | 'saveGenerationWorkspace'
> = {
  getGenerationWorkspace: async () => structuredClone(stored),
  saveGenerationWorkspace: async (_projectId, next) => {
    if (next.revision !== stored.revision)
      throw new Error('Fixture revision conflict');
    stored = { ...structuredClone(next), revision: stored.revision + 1 };
    writes++;
    notify();
    return structuredClone(stored);
  },
};
Object.assign(window, {
  desktop: {
    ...referenceImportMock().bridge,
    ...draftMock.bridge,
    ...workspaceBridge,
  },
});
const snapshot: ProjectSnapshot = {
  project: {
    id: 'keyboard-project',
    folder: 'keyboard-project',
    name: '键盘测试',
    updatedAt: '',
  },
  assets: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  canvas: { version: 1, revision: 0, cards: [] },
};

function Fixture() {
  const [blocked, setBlocked] = useState(false);
  const [shortcuts, setShortcuts] = useState(
    defaultInteractionSettings().shortcuts,
  );
  const [dialog, setDialog] = useState(false);
  const [, render] = useState(0);
  const shots = useShotWorkspace(snapshot.project.id, blocked);
  const opened = useRef(false);
  useEffect(() => {
    if (shots.loaded && !opened.current) {
      opened.current = true;
      shots.open('shot');
    }
  }, [shots.loaded, shots.open]);
  useLayoutEffect(() => {
    notify = () => render((value) => value + 1);
    Object.assign(window, {
      materialKeys: {
        state: () => ({
          current: shots.shots[0],
          stored,
          writes,
          blocked,
          shortcuts,
          active: shots.activeId,
          canUndo: shots.historyFor('shot').canUndo,
          canRedo: shots.historyFor('shot').canRedo,
        }),
        flush: shots.flush,
        reopen: () => shots.open('shot'),
        block: setBlocked,
        dialog: setDialog,
        binding: (action: ShortcutAction, value: Shortcuts[ShortcutAction]) =>
          setShortcuts((current) => ({ ...current, [action]: value })),
        defaults: () => setShortcuts(defaultInteractionSettings().shortcuts),
        cloneBindings: () =>
          setShortcuts((current) => structuredClone(current)),
      },
    });
  });
  return (
    <>
      {shots.activeShot && (
        <MaterialCanvas
          shot={shots.activeShot}
          snapshot={snapshot}
          blocked={blocked}
          longPressSplit
          saving={shots.saving}
          error={shots.error}
          shortcuts={shortcuts}
          history={shots.historyFor('shot')}
          onChange={(update, options) =>
            shots.updateShot('shot', update, options)
          }
          onClose={shots.dismiss}
          beforeClose={shots.flush}
          retry={shots.retry}
        />
      )}
      {dialog &&
        createPortal(
          <dialog open aria-label="测试弹窗">
            <button type="button">弹窗内操作</button>
          </dialog>,
          document.body,
        )}
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
