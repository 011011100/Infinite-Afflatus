import { StrictMode, useCallback, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { projectRecoveryGuards } from '@/features/projects/project-recovery-guards';
import { ProjectCanvas } from '@/features/workspace/project-canvas';
import { useInputMethod } from '@/lib/input-method';
import {
  applyCanvasPatch,
  type CanvasPatch,
} from '../../src/shared/canvas/model';
import type { DesktopBridge } from '../../src/shared/desktop';
import {
  emptyWorkspace,
  groupMaterials,
  newShot,
  validateWorkspace,
} from '../../src/shared/generation/workspace';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type { Asset, ProjectSnapshot } from '../../src/shared/models';
import { projectEditDraftMock } from './project-edit-draft-mock';
import { referenceImportMock } from './reference-import-mock';
import { workspaceDraftMock } from './workspace-draft-mock';
import '../../src/renderer/src/styles.css';

// The real ProjectCanvas owns every gesture and both history domains. Controls
// below only observe isolated persistence or inject a native-storage boundary.
const assetA = '10000000-0000-4000-8000-000000000001';
const assetB = '10000000-0000-4000-8000-000000000002';
const imageId = '10000000-0000-4000-8000-000000000003';
const assets: Asset[] = [
  { id: assetA, name: '开场.mp4', kind: 'video' },
  { id: assetB, name: '结尾.mp4', kind: 'video' },
  { id: imageId, name: '参考图.svg', kind: 'image', usage: 'reference' },
].map((asset) => ({
  ...asset,
  relativePath: `assets/${asset.id}`,
  size: 100,
  sha256: 'a'.repeat(64),
})) as Asset[];
const seed = newShot('seed-shot', '已存独立镜头', { x: 100, y: 340 });
seed.nodes = [
  {
    id: 'solo-text',
    type: 'text',
    text: '原始独立正文',
    position: { x: 60, y: 100 },
  },
  {
    id: 'group-text',
    type: 'text',
    text: '组内动作',
    position: { x: 450, y: 100 },
  },
  {
    id: 'group-image',
    type: 'asset',
    assetId: imageId,
    position: { x: 740, y: 100 },
  },
];
seed.labels = [
  {
    id: 'pinned-label',
    name: '固定位置',
    color: '#2563eb',
    pinned: true,
    position: { x: 70, y: 420 },
  },
];
const grouped = groupMaterials(
  seed,
  ['group-text', 'group-image'],
  'seed-group',
);
const seedGroup = grouped.groups[0];
if (!seedGroup) throw new Error('Fixture seed group was not created');
seedGroup.parameters = {
  model: 'seedance-2.0-fast',
  ratio: '9:16',
  resolution: '480p',
  duration: 12,
  generateAudio: false,
};
const associated = newShot(
  'associated-shot',
  '视频关联镜头',
  { x: 0, y: 0 },
  assetA,
);
let stored = validateWorkspace({
  ...emptyWorkspace(),
  shots: [grouped, associated],
});
const initialWorkspace = structuredClone(stored);
let remote: ProjectSnapshot = {
  project: {
    id: 'history-project',
    folder: 'history-project',
    name: '主画布历史验收',
    updatedAt: '',
  },
  assets,
  viewport: { x: 0, y: 0, zoom: 1 },
  canvas: {
    version: 1,
    revision: 0,
    cards: [
      {
        id: '20000000-0000-4000-8000-000000000001',
        assetIds: [assetA],
        position: { x: 100, y: 70 },
        trims: { [assetA]: { start: 0.1, end: 0.8 } },
      },
      {
        id: '20000000-0000-4000-8000-000000000002',
        assetIds: [assetB],
        position: { x: 490, y: 70 },
        trims: { [assetB]: { start: 0.2, end: 0.9 } },
      },
    ],
  },
};
const initialSnapshot = structuredClone(remote);
type Fault =
  | 'none'
  | 'reject'
  | 'lost-exact'
  | 'lost-read-failure'
  | 'lost-different'
  | 'lost-revision';
let workspaceFault: Fault = 'none';
let canvasReject = false;
let holdNext = false;
let release: (() => void) | null = null;
let holdNextCanvas = false;
let releaseCanvas: (() => void) | null = null;
let readFailures = 0;
let blockOnReport = false;
let unavailable = false;
let setUnavailable: (value: boolean) => void = () => {};
let reads = 0;
const recoveries: (string | null)[] = [];
const saves: { input: typeof stored; committed: boolean }[] = [];
const patches: { input: CanvasPatch; committed: boolean }[] = [];
const reports: string[] = [];
const drafts = workspaceDraftMock(() => stored);
const edits = projectEditDraftMock(() => remote);
const bridge: Pick<
  DesktopBridge,
  | 'getGenerationWorkspace'
  | 'saveGenerationWorkspace'
  | 'patchCanvas'
  | 'saveViewport'
  | 'openProject'
  | 'readReferenceText'
> = {
  getGenerationWorkspace: async () => {
    reads++;
    if (readFailures > 0) {
      readFailures--;
      throw new Error('保存后补读不可用（验收注入）');
    }
    return structuredClone(stored);
  },
  saveGenerationWorkspace: async (_id, input) => {
    const next = validateWorkspace(input);
    const attempt = { input: next, committed: false };
    saves.push(attempt);
    if (holdNext) {
      holdNext = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      release = null;
    }
    if (next.revision !== stored.revision)
      throw new Error('镜头版本冲突（验收注入）');
    if (workspaceFault === 'reject')
      throw new Error('镜头保存失败（验收注入）');
    stored = { ...structuredClone(next), revision: next.revision + 1 };
    attempt.committed = true;
    const fault = workspaceFault;
    if (fault.startsWith('lost-')) {
      workspaceFault = 'none';
      if (fault === 'lost-different') {
        const remaining = stored.shots[0];
        if (!remaining)
          throw new Error('Fixture conflict needs a remaining shot');
        remaining.name = '外部提交的不同内容';
      }
      if (fault === 'lost-revision') stored.revision++;
      if (fault === 'lost-read-failure') readFailures++;
      throw new Error('保存回执丢失（验收注入）');
    }
    return structuredClone(stored);
  },
  patchCanvas: async (_id, input) => {
    const attempt = { input: structuredClone(input), committed: false };
    patches.push(attempt);
    if (canvasReject) throw new Error('视频保存失败（验收注入）');
    remote = { ...remote, canvas: applyCanvasPatch(remote.canvas, input) };
    attempt.committed = true;
    if (holdNextCanvas) {
      holdNextCanvas = false;
      await new Promise<void>((resolve) => {
        releaseCanvas = resolve;
      });
      releaseCanvas = null;
    }
    return structuredClone(remote);
  },
  saveViewport: async (_id, viewport) => {
    remote.viewport = structuredClone(viewport);
  },
  openProject: async () => structuredClone(remote),
  readReferenceText: async () => '只读源文件',
};
Object.assign(window, {
  desktop: {
    ...referenceImportMock().bridge,
    ...drafts.bridge,
    ...edits.bridge,
    ...bridge,
  },
  projectHistory: {
    state: () =>
      structuredClone({
        stored,
        remote,
        initialWorkspace,
        initialSnapshot,
        saves,
        patches,
        reports,
        workspaceFault,
        canvasReject,
        reads,
        readFailures,
        unavailable,
        recoveries,
        pending: !!release,
        canvasPending: !!releaseCanvas,
        drafts: [...drafts.records.values()],
      }),
    fault: (value: Fault) => {
      workspaceFault = value;
      blockOnReport = value === 'lost-read-failure';
    },
    rejectCanvas: (value: boolean) => {
      canvasReject = value;
    },
    holdNext: () => {
      holdNext = true;
    },
    release: () => release?.(),
    holdNextCanvas: () => {
      holdNextCanvas = true;
    },
    releaseCanvas: () => releaseCanvas?.(),
    verify: async (rejectAnotherGuard = false) => {
      // Registration happens after the real ProjectCanvas editors mounted, so
      // their submission guard runs before this independent editor's refusal.
      const unregister = projectRecoveryGuards.register(
        remote.project.id,
        () =>
          rejectAnotherGuard ? '另一个编辑器仍有未确认内容（验收注入）' : null,
      );
      try {
        const reason = await projectRecoveryGuards.verify(
          remote.project.id,
          structuredClone(remote),
        );
        recoveries.push(reason);
        if (!reason) setUnavailable(false);
        return reason;
      } finally {
        unregister();
      }
    },
  },
});
function Fixture() {
  useInputMethod();
  const [blocked, setBlocked] = useState(false);
  useLayoutEffect(() => {
    setUnavailable = (value) => {
      unavailable = value;
      setBlocked(value);
    };
    return () => {
      setUnavailable = () => {};
    };
  }, []);
  const report = useCallback((error: unknown) => {
    reports.push(error instanceof Error ? error.message : String(error));
    if (blockOnReport) setUnavailable(true);
  }, []);
  return (
    <div className="flex h-full flex-col">
      <ProjectCanvas
        snapshot={initialSnapshot}
        blocked={blocked}
        projectUnavailable={blocked}
        inactive={false}
        interactions={defaultInteractionSettings()}
        report={report}
      />
    </div>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
