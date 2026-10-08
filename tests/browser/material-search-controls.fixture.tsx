import {
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';
import { HoldFeedbackProvider } from '@/components/canvas/hold-feedback';
import { MaterialCanvas } from '@/features/generation/material-canvas';
import { useShotWorkspace } from '@/features/generation/use-shot-workspace';
import { useInputMethod } from '@/lib/input-method';
import type { DesktopBridge } from '../../src/shared/desktop';
import {
  emptyWorkspace,
  groupMaterials,
  newShot,
} from '../../src/shared/generation/workspace';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type { Shortcut } from '../../src/shared/interaction/shortcuts';
import type { Asset, ProjectSnapshot } from '../../src/shared/models';
import { referenceImportMock } from './reference-import-mock';
import { workspaceDraftMock } from './workspace-draft-mock';
import '../../src/renderer/src/styles.css';

const assets: Asset[] = (
  [
    ['image-a', 'IMAGE 晨光.png', 'image'],
    ['text-a', 'SCRIPT 01 分镜.txt', 'text'],
    ['video-a', '海边 片段.mp4', 'video'],
    ['audio-a', '背景 音乐.wav', 'audio'],
    ['text-b', 'SCRIPT 02 分镜.txt', 'text'],
  ] as const
).map(([id, name, kind]) => ({
  id,
  name,
  kind,
  relativePath: `assets/${id}`,
  size: 10,
  sha256: '',
}));
const initial = newShot('shot', '素材查找', { x: 100, y: 200 });
initial.nodes = [
  {
    id: 'solo',
    type: 'text',
    name: '开场',
    text: '城市的早晨',
    position: { x: 80, y: 160 },
  },
  {
    id: 'member',
    type: 'text',
    name: '远处细节',
    text: '海边 晨光对白',
    position: { x: 2300, y: 1800 },
  },
  {
    id: 'member2',
    type: 'text',
    name: '同组另一段',
    text: '远处动作',
    position: { x: 2600, y: 1800 },
  },
];
initial.labels = [
  {
    id: 'label',
    name: '结尾位置',
    color: '#2563eb',
    pinned: true,
    position: { x: -1400, y: 1500 },
  },
];
let stored = {
  ...emptyWorkspace(),
  shots: [groupMaterials(initial, ['member', 'member2'], 'group')],
};
const bridge: Pick<
  DesktopBridge,
  'getGenerationWorkspace' | 'saveGenerationWorkspace' | 'readReferenceText'
> = {
  getGenerationWorkspace: async () => structuredClone(stored),
  saveGenerationWorkspace: async (_id, next) => {
    if (next.revision !== stored.revision)
      throw new Error('Fixture revision conflict');
    stored = { ...structuredClone(next), revision: stored.revision + 1 };
    return structuredClone(stored);
  },
  readReferenceText: async () => '测试源文件内容',
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
    id: 'search-project',
    name: '素材查找验证',
    folder: 'search-project',
    updatedAt: '',
  },
  viewport: { x: 0, y: 0, zoom: 1 },
  assets,
  canvas: { version: 1, revision: 0, cards: [] },
};

function Fixture() {
  useInputMethod();
  const [blocked, setBlocked] = useState(false);
  const [shortcuts, setShortcuts] = useState(
    defaultInteractionSettings().shortcuts,
  );
  const shots = useShotWorkspace(snapshot.project.id, blocked);
  const opened = useRef(false);
  useEffect(() => {
    if (shots.loaded && !opened.current) {
      opened.current = true;
      shots.open('shot');
    }
  }, [shots.loaded, shots.open]);
  useLayoutEffect(() => {
    Object.assign(window, {
      materialSearch: {
        state: () => ({
          shot: shots.shots[0],
          stored,
          canUndo: shots.historyFor('shot').canUndo,
        }),
        flush: shots.flush,
        block: setBlocked,
        binding: (value: Shortcut | null) =>
          setShortcuts((current) => ({ ...current, findMaterials: value })),
        reopen: () => shots.open('shot'),
      },
    });
  });
  return (
    shots.activeShot && (
      <MaterialCanvas
        shot={shots.activeShot}
        snapshot={snapshot}
        blocked={blocked}
        longPressSplit
        shortcuts={shortcuts}
        history={shots.historyFor('shot')}
        saving={shots.saving}
        error={shots.error}
        onChange={(update, options) =>
          shots.updateShot('shot', update, options)
        }
        onClose={shots.dismiss}
        beforeClose={shots.flush}
        retry={shots.retry}
      />
    )
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
