import {
  Background,
  BackgroundVariant,
  type Edge,
  Panel,
  ReactFlow,
  type ReactFlowInstance,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CanvasControls } from '@/components/canvas/canvas-controls';
import { CARD_HEIGHT, cardWidth } from '../../../../shared/canvas/model';
import { splitCard } from '../../../../shared/canvas/operations';
import type { Asset, ProjectSnapshot } from '../../../../shared/models';
import { CanvasActions } from './canvas-actions';
import { SequencePlayer } from './sequence-player';
import { useCanvasDocument } from './use-canvas-document';
import { useCardDrag } from './use-card-drag';
import { VideoCard, type VideoCardNode } from './video-card';

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
  const document = useCanvasDocument(snapshot, blocked, report);
  const { cards } = document.snapshot.canvas;
  const [selection, setSelection] = useState<{
    cardId: string;
    assetId: string | null;
  } | null>(null);
  const [playing, setPlaying] = useState<Asset[] | null>(null);
  const [measurements, setMeasurements] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const flow = useRef<ReactFlowInstance<VideoCardNode> | null>(null);
  const assets = useMemo(
    () => new Map(document.snapshot.assets.map((asset) => [asset.id, asset])),
    [document.snapshot.assets],
  );
  const selectCard = useCallback((id: string) => {
    setSelection((current) =>
      current?.cardId === id ? current : { cardId: id, assetId: null },
    );
  }, []);
  const selectAsset = useCallback(
    (cardId: string, assetId: string) => setSelection({ cardId, assetId }),
    [],
  );
  const drag = useCardDrag(cards, blocked, document.commit, selectCard);
  const play = useCallback(
    (id: string) => {
      const card = cards.find((item) => item.id === id);
      if (card) {
        selectCard(id);
        setPlaying(
          card.assetIds
            .map((assetId) => assets.get(assetId))
            .filter((asset): asset is Asset => !!asset),
        );
      }
    },
    [assets, cards, selectCard],
  );
  const selectedCard = cards.find((card) => card.id === selection?.cardId);
  const split = () => {
    if (!selectedCard || selectedCard.assetIds.length < 2) return;
    const patch = splitCard(
      selectedCard,
      selectedCard.assetIds.map((_id, index) =>
        index === 0 ? selectedCard.id : crypto.randomUUID(),
      ),
    );
    void document.commit(patch);
  };
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest(
          'dialog, input, textarea, select, [contenteditable="true"]',
        )
      )
        return;
      if (event.key === 'Escape') {
        if (!drag.cancel()) setSelection(null);
        event.preventDefault();
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === 'z'
      ) {
        event.preventDefault();
        if (blocked || document.saving || drag.drag) return;
        if (event.shiftKey) document.redo();
        else document.undo();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [
    drag.cancel,
    drag.drag,
    document.undo,
    document.redo,
    document.saving,
    blocked,
  ]);

  const nodes = useMemo<VideoCardNode[]>(
    () =>
      cards.map((card) => ({
        id: card.id,
        type: 'video',
        position:
          drag.drag?.original.id === card.id
            ? drag.drag.position
            : card.position,
        selected: selection?.cardId === card.id,
        // Keep dimensions across controlled-node updates; losing them briefly hides the node during a click.
        measured: measurements[card.id] ?? {
          width: cardWidth(card),
          height: CARD_HEIGHT,
        },
        data: {
          assets: card.assetIds
            .map((id) => assets.get(id))
            .filter((asset): asset is Asset => !!asset),
          projectId: snapshot.project.id,
          width: cardWidth(card),
          activeAssetId:
            selection?.cardId === card.id ? selection.assetId : null,
          snapSide:
            drag.drag?.snap?.targetId === card.id ? drag.drag.snap.side : null,
          play,
          selectAsset,
        },
      })),
    [
      cards,
      drag.drag,
      selection,
      assets,
      snapshot.project.id,
      play,
      selectAsset,
      measurements,
    ],
  );
  const snapTarget = cards.find(
    (card) => card.id === drag.drag?.snap?.targetId,
  );
  const snapCards =
    snapTarget && drag.drag
      ? drag.drag.snap?.side === 'left'
        ? [drag.drag.original, snapTarget]
        : [snapTarget, drag.drag.original]
      : [];

  return (
    <main
      className="relative min-h-0 flex-1"
      aria-label="视频创作画布"
      aria-busy={document.saving}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        defaultViewport={snapshot.viewport}
        onInit={(instance) => {
          flow.current = instance;
        }}
        minZoom={0.25}
        maxZoom={2}
        nodesConnectable={false}
        nodesDraggable={!blocked && !document.saving}
        nodeDragThreshold={0}
        nodeClickDistance={5}
        deleteKeyCode={null}
        multiSelectionKeyCode={null}
        selectionKeyCode={null}
        disableKeyboardA11y
        zoomOnDoubleClick={false}
        panOnDrag={!blocked}
        zoomOnScroll={!blocked}
        zoomOnPinch={!blocked}
        onNodesChange={(changes) => {
          for (const change of changes) {
            if (change.type === 'select' && change.selected)
              selectCard(change.id);
            if (change.type === 'dimensions' && change.dimensions) {
              const size = change.dimensions;
              setMeasurements((current) =>
                current[change.id]?.width === size.width &&
                current[change.id]?.height === size.height
                  ? current
                  : { ...current, [change.id]: size },
              );
            }
          }
        }}
        onPaneClick={() => setSelection(null)}
        onNodeDragStart={(_event, node) => drag.start(node.id)}
        onNodeDrag={(_event, node) =>
          drag.move(node.position, flow.current?.getZoom() ?? 1)
        }
        onNodeDragStop={(_event, node) => {
          void drag.stop(node.position, flow.current?.getZoom() ?? 1);
        }}
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
        <Panel position="bottom-center">
          <CanvasActions
            disabled={blocked || document.saving || !!drag.drag}
            canUndo={document.canUndo}
            canRedo={document.canRedo}
            canSplit={!!selectedCard && selectedCard.assetIds.length > 1}
            undo={document.undo}
            redo={document.redo}
            split={split}
          />
        </Panel>
        <Panel position="top-center" className="pointer-events-none">
          {snapTarget ? (
            <p
              role="status"
              className="max-w-[70vw] truncate rounded-full border border-primary/20 bg-background px-4 py-2 text-xs text-primary shadow-sm"
            >
              松开拼接 ·{' '}
              {snapCards
                .map((card) =>
                  card.assetIds.length > 1
                    ? `${card.assetIds.length} 段组合`
                    : assets.get(card.assetIds[0] ?? '')?.name,
                )
                .join(' → ')}{' '}
              <span className="ml-2 text-muted-foreground">Esc 取消</span>
            </p>
          ) : (
            <p className="rounded-full bg-canvas/90 px-3 py-1.5 text-xs text-muted-foreground">
              {document.saving
                ? '正在保存…'
                : cards.length > 1
                  ? '拖到卡片左侧或右侧，松开即可拼接'
                  : '拖动卡片排列 · 点击播放放大预览'}
            </p>
          )}
        </Panel>
      </ReactFlow>
      {!nodes.length && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-muted-foreground select-none">
          <h1 className="mb-2.5 text-xl font-medium">从一个镜头开始</h1>
          <p className="text-sm">导入一段视频，开始你的创作</p>
        </div>
      )}
      {playing && (
        <SequencePlayer
          assets={playing}
          projectId={snapshot.project.id}
          onClose={() => setPlaying(null)}
        />
      )}
    </main>
  );
}
