import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GroupTextInput } from '@/features/generation/group-text-input';
import { useShotWorkspace } from '@/features/generation/use-shot-workspace';
import { useProjectHealth } from '@/features/projects/use-project-health';
import type { TimelineClip } from '@/features/workspace/editor/timeline';
import { useSequencePlayback } from '@/features/workspace/playback/use-sequence-playback';
import { refreshRestoredMedia } from '@/features/workspace/use-media-revision';
import { editMaterialText } from '../../src/shared/generation/group-editing';
import {
  type GenerationWorkspace,
  newShot,
} from '../../src/shared/generation/workspace';
import '../../src/renderer/src/styles.css';

const projectId = 'media-recovery';
const shot = newShot('shot', '修复中的镜头', { x: 0, y: 0 });
shot.nodes = [
  {
    id: 'source-node',
    type: 'asset',
    assetId: 'text-source',
    position: { x: 0, y: 0 },
  },
  {
    id: 'draft-node',
    type: 'asset',
    assetId: 'text-source',
    textOverride: '原有独立草稿',
    position: { x: 300, y: 0 },
  },
];
let stored: GenerationWorkspace = { version: 1, revision: 0, shots: [shot] };
let sourceAvailable = false;
let scanCalls = 0;
let cancelCalls = 0;
const bridge = {
  getGenerationWorkspace: async () => structuredClone(stored),
  saveGenerationWorkspace: async (_id, workspace) => {
    if (workspace.revision !== stored.revision)
      throw new Error('测试中的保存版本冲突');
    stored = { ...structuredClone(workspace), revision: stored.revision + 1 };
    return structuredClone(stored);
  },
  prepareProxy: async () => ({ ready: false }),
  readReferenceText: async () => {
    if (!sourceAvailable) throw new Error('原文本暂时缺失');
    return '恢复后的原文本';
  },
  scanProjectHealth: async (id, mode) => {
    scanCalls++;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      projectId: id,
      mode,
      checkedAt: new Date().toISOString(),
      assetCount: 3,
      issues: [],
    };
  },
  cancelProjectHealth: async () => {
    cancelCalls++;
  },
  onProjectHealthProgress: () => () => {},
} satisfies Partial<typeof window.desktop>;
Object.defineProperty(window, 'desktop', { value: bridge });

const clips: TimelineClip[] = ['first-clip', 'second-clip'].map((id, i) => ({
  asset: {
    id,
    name: `${id}.mp4`,
    kind: 'video',
    relativePath: `assets/videos/${id}.mp4`,
    sha256: 'unchanged-hash',
    size: 1,
  },
  duration: 5,
  range: { start: 0, end: 5 },
  offset: i * 5,
  length: 5,
}));

function Check() {
  const health = useProjectHealth(projectId, false);
  const workspace = useShotWorkspace(projectId, false);
  const current = workspace.shots[0];
  const history = workspace.historyFor('shot');
  const playback = useSequencePlayback(projectId, clips);
  const [loads, setLoads] = useState(0);
  return (
    <main className="space-y-3 p-4">
      <div className="flex gap-3">
        <button
          type="button"
          id="second-paused-muted"
          onClick={() => {
            playback.mute(true);
            playback.select(1, 2, false);
          }}
        >
          第二段静音暂停
        </button>
        <button
          type="button"
          id="restore-unrelated"
          onClick={() => refreshRestoredMedia(projectId, 'unrelated-image')}
        >
          恢复无关图片
        </button>
        <button
          type="button"
          id="restore-current"
          onClick={() => refreshRestoredMedia(projectId, 'second-clip')}
        >
          恢复当前视频
        </button>
        <button
          type="button"
          id="restore-text"
          onClick={() => {
            sourceAvailable = true;
            refreshRestoredMedia(projectId, 'text-source');
          }}
        >
          恢复原文本
        </button>
        <button type="button" id="undo" onClick={history.undo}>
          撤销草稿
        </button>
        <button type="button" id="redo" onClick={history.redo}>
          重做草稿
        </button>
      </div>
      <div className="relative h-44 w-80 bg-black">
        {playback.videoRefs.map(({ id, ref }) => (
          <video
            key={id}
            ref={ref}
            data-player={id}
            playsInline
            className="absolute inset-0 size-full"
            onLoadedData={() => setLoads((value) => value + 1)}
          >
            <track kind="captions" />
          </video>
        ))}
      </div>
      {current?.nodes.map((node, index) => (
        <div key={node.id} data-text-node={node.id}>
          <GroupTextInput
            node={node}
            index={index}
            projectId={projectId}
            focus={false}
            disabled={false}
            onChange={(text) =>
              workspace.updateShot(
                current.id,
                (value) => editMaterialText(value, node.id, text),
                { mergeKey: `text:${node.id}` },
              )
            }
          />
        </div>
      ))}
      <output id="state">
        {JSON.stringify({
          loaded: workspace.loaded,
          nodes: current?.nodes,
          canUndo: history.canUndo,
          canRedo: history.canRedo,
          saveError: workspace.error,
          health: {
            report: health.report,
            busy: health.busy,
            scanCalls,
            cancelCalls,
          },
          playback: {
            index: playback.index,
            time: playback.time,
            playing: playback.playing,
            pending: playback.pending,
            error: playback.error,
            loads,
          },
        })}
      </output>
    </main>
  );
}

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <Check />
    </StrictMode>,
  );
