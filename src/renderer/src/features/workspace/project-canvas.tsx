import {
  Background,
  BackgroundVariant,
  type Edge,
  Panel,
  ReactFlow,
} from '@xyflow/react';
import { useMemo, useState } from 'react';
import { CanvasControls } from '@/components/canvas/canvas-controls';
import { Modal } from '@/components/ui/modal';
import type { Asset, ProjectSnapshot } from '../../../../shared/models';
import { mediaUrl, VideoCard, type VideoCardNode } from './video-card';

const edges: Edge[] = [];
const nodeTypes = { video: VideoCard };
export function ProjectCanvas({
  snapshot,
  blocked,
  report,
}: {
  snapshot: ProjectSnapshot;
  blocked: boolean;
  report: (error: unknown) => void;
}) {
  const [playing, setPlaying] = useState<Asset | null>(null);
  const nodes = useMemo<VideoCardNode[]>(
    () =>
      snapshot.assets
        .filter((asset) => asset.kind === 'video')
        .map((asset, index) => ({
          id: asset.id,
          type: 'video',
          position: {
            x: 100 + (index % 3) * 330,
            y: 100 + Math.floor(index / 3) * 240,
          },
          data: { asset, projectId: snapshot.project.id, play: setPlaying },
        })),
    [snapshot.assets, snapshot.project.id],
  );
  return (
    <main className="relative min-h-0 flex-1" aria-label="视频创作画布">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        defaultViewport={snapshot.viewport}
        minZoom={0.25}
        maxZoom={2}
        nodesConnectable={false}
        nodesDraggable={false}
        zoomOnDoubleClick={false}
        panOnDrag={!blocked}
        zoomOnScroll={!blocked}
        zoomOnPinch={!blocked}
        onMoveEnd={(_event, viewport) => {
          if (!blocked)
            void window.desktop
              .saveViewport(snapshot.project.id, viewport)
              .catch(report);
        }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="var(--canvas-dot)"
        />
        {!blocked && <CanvasControls />}
        <Panel
          position="bottom-left"
          className="text-xs text-muted-foreground select-none"
        >
          {nodes.length
            ? `${nodes.length} 个视频 · 点击播放预览`
            : '拖动画布 · 滚轮缩放'}
        </Panel>
      </ReactFlow>
      {!nodes.length && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-muted-foreground select-none">
          <h1 className="mb-2.5 text-xl font-medium">从一个镜头开始</h1>
          <p className="text-sm">导入一段视频，开始你的创作</p>
        </div>
      )}
      {playing && (
        <Modal title={playing.name} wide onClose={() => setPlaying(null)}>
          <video
            controls
            autoPlay
            src={mediaUrl(snapshot.project.id, playing.id)}
            className="max-h-[65vh] w-full rounded-lg bg-black"
          >
            <track kind="captions" />
          </video>
        </Modal>
      )}
    </main>
  );
}
