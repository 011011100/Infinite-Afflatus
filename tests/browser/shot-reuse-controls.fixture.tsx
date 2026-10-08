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
  validateWorkspace,
} from '../../src/shared/generation/workspace';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type { Asset, ProjectSnapshot } from '../../src/shared/models';
import { referenceImportMock } from './reference-import-mock';
import { workspaceDraftMock } from './workspace-draft-mock';
import '../../src/renderer/src/styles.css';

const mode = new URL(location.href).searchParams.get('mode') ?? 'normal';
const assets: Asset[] = (
  [
    ['generated-video', '已生成视频.mp4', 'video'],
    ['reference-image', '固定参考图.svg', 'image'],
    ['reference-text', '原始分镜.txt', 'text'],
  ] as const
).map(([id, name, kind]) => ({
  id,
  name,
  kind,
  relativePath: `assets/${id}`,
  size: 10,
  sha256: 'a'.repeat(64),
  ...(kind === 'video' ? {} : { usage: 'reference' as const }),
}));
const source = newShot(
  'source-shot',
  '雨夜镜头',
  { x: 100, y: 200 },
  'generated-video',
);
source.nodes = [
  {
    id: 'solo',
    type: 'text',
    name: '开场对白',
    text: '原镜头独立文字',
    position: { x: 60, y: 100 },
    width: 320,
    height: 244,
  },
  {
    id: 'video-text',
    type: 'text',
    text: '视频组动作',
    position: { x: 460, y: 100 },
  },
  {
    id: 'text-reference',
    type: 'asset',
    assetId: 'reference-text',
    textOverride: '仅镜头内编辑的分镜',
    position: { x: 740, y: 100 },
  },
  {
    id: 'image-text',
    type: 'text',
    text: '图片组描述',
    position: { x: 460, y: 520 },
  },
  {
    id: 'image-reference',
    type: 'asset',
    assetId: 'reference-image',
    position: { x: 740, y: 520 },
  },
];
source.labels = [
  {
    id: 'pinned-label',
    name: '固定结尾位置',
    color: '#2563eb',
    pinned: true,
    position: { x: 100, y: 480 },
  },
];
let initial = groupMaterials(
  source,
  ['video-text', 'text-reference'],
  'video-group',
);
initial = groupMaterials(
  initial,
  ['image-text', 'image-reference'],
  'image-group',
  undefined,
  { kind: 'image', assets },
);
for (const group of initial.groups) {
  if (group.kind === 'image') {
    group.parameters = {
      model: 'seedream-5.0-lite',
      ratio: '3:2',
      resolution: '3K',
    };
  } else {
    group.parameters = {
      model: 'seedance-2.0-fast',
      ratio: '9:16',
      resolution: '480p',
      duration: 12,
      generateAudio: false,
    };
  }
}
let stored = validateWorkspace({
  ...emptyWorkspace(),
  shots: [
    initial,
    ...(mode === 'capacity'
      ? Array.from({ length: 499 }, (_, index) =>
          newShot(`other-${index}`, `其他镜头 ${index}`, { x: 0, y: 0 }),
        )
      : []),
  ],
});
const originalCount = stored.shots.length;
const attempts: (typeof stored)[] = [];
let rejectCopies = mode === 'copy-failure';
let rejectSource = mode === 'source-failure';
let holdCopy = mode === 'copy-failure';
let releaseCopy: (() => void) | null = null;
const drafts = workspaceDraftMock(() => stored);
const bridge: Pick<
  DesktopBridge,
  'getGenerationWorkspace' | 'saveGenerationWorkspace' | 'readReferenceText'
> = {
  getGenerationWorkspace: async () => structuredClone(stored),
  saveGenerationWorkspace: async (_projectId, input) => {
    const next = validateWorkspace(input);
    attempts.push(structuredClone(next));
    if (next.revision !== stored.revision)
      throw new Error('Fixture revision conflict');
    if (next.shots.length > originalCount) {
      if (holdCopy) {
        await new Promise<void>((resolve) => {
          releaseCopy = resolve;
        });
        holdCopy = false;
        releaseCopy = null;
      }
      if (rejectCopies) throw new Error('副本保存注入失败');
    } else if (rejectSource) throw new Error('原稿保存注入失败');
    stored = { ...structuredClone(next), revision: stored.revision + 1 };
    return structuredClone(stored);
  },
  readReferenceText: async () => '磁盘原始分镜内容，任何镜头编辑都不能改写它。',
};
Object.assign(window, {
  desktop: { ...referenceImportMock().bridge, ...drafts.bridge, ...bridge },
});
const snapshot: ProjectSnapshot = {
  project: {
    id: 'reuse-project',
    folder: 'reuse-project',
    name: '镜头复用验证',
    updatedAt: '',
  },
  assets,
  viewport: { x: 0, y: 0, zoom: 1 },
  canvas: { version: 1, revision: 0, cards: [] },
};
const shortcuts = defaultInteractionSettings().shortcuts;

function Fixture() {
  useInputMethod();
  const [blocked, setBlocked] = useState(false);
  const shots = useShotWorkspace(snapshot.project.id, blocked);
  const opened = useRef(false);
  useEffect(() => {
    if (shots.loaded && !opened.current) {
      opened.current = true;
      shots.open('source-shot');
    }
  }, [shots.loaded, shots.open]);
  useLayoutEffect(() => {
    Object.assign(window, {
      shotReuse: {
        state: () => ({
          shots: shots.shots,
          activeId: shots.activeId,
          stored,
          attempts,
          blocked,
          saving: shots.saving,
          error: shots.error,
          duplicatePending: shots.duplicatePending,
          copyWritePending: !!releaseCopy,
          histories: Object.fromEntries(
            shots.shots.map((shot) => {
              const history = shots.historyFor(shot.id);
              return [
                shot.id,
                { canUndo: history.canUndo, canRedo: history.canRedo },
              ];
            }),
          ),
          drafts: [...drafts.records.values()],
        }),
        flush: shots.flush,
        block: setBlocked,
        releaseCopy: () => releaseCopy?.(),
        allowWrites: () => {
          rejectCopies = false;
          rejectSource = false;
        },
      },
    });
  });
  return (
    <>
      <main aria-label="镜头列表">
        {shots.shots.map((shot) => (
          <button
            key={shot.id}
            type="button"
            data-open-shot={shot.id}
            onClick={() => shots.open(shot.id)}
          >
            打开镜头：{shot.name}
          </button>
        ))}
      </main>
      {shots.activeShot && (
        <MaterialCanvas
          key={`materials:${shots.activeShot.id}`}
          shot={shots.activeShot}
          snapshot={snapshot}
          blocked={blocked}
          longPressSplit
          shortcuts={shortcuts}
          saving={shots.saving}
          error={shots.error}
          history={shots.historyFor(shots.activeShot.id)}
          onChange={(update, options) => {
            if (shots.activeId)
              shots.updateShot(shots.activeId, update, options);
          }}
          onClose={shots.dismiss}
          beforeClose={shots.flush}
          retry={shots.retry}
          duplicatePending={shots.duplicatePending}
          onDuplicate={async () =>
            !!shots.activeId &&
            !!(await shots.duplicate(shots.activeId, { x: 560, y: 200 }))
          }
        />
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
