import {
  Background,
  BackgroundVariant,
  type Edge,
  Panel,
  ReactFlow,
  type ReactFlowInstance,
} from '@xyflow/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { CanvasControls } from '@/components/canvas/canvas-controls';
import { isMac } from '@/lib/platform';
import { CARD_HEIGHT, cardWidth } from '../../../../shared/canvas/model';
import { splitSelectedAsset } from '../../../../shared/canvas/operations';
import { DRAG_THRESHOLD } from '../../../../shared/interaction/long-press';
import type { InteractionSettings } from '../../../../shared/interaction/settings';
import type { Asset, ProjectSnapshot } from '../../../../shared/models';
import { CanvasActions } from './canvas-actions';
import { SequencePlayer } from './sequence-player';
import { useCanvasDocument } from './use-canvas-document';
import { useCanvasShortcuts } from './use-canvas-shortcuts';
import { useCardDrag } from './use-card-drag';
import { VideoCard, type VideoCardNode } from './video-card';

const edges: Edge[] = [];
const nodeTypes = { video: VideoCard };
export function ProjectCanvas({
  snapshot,
  blocked,
  interactions,
  inactive,
  report,
}: {
  snapshot: ProjectSnapshot;
  blocked: boolean;
  interactions: InteractionSettings;
  inactive: boolean;
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
  const selectedAssetId = selection?.assetId;
  const canSplit =
    !!selectedCard &&
    selectedCard.assetIds.length > 1 &&
    !!selectedAssetId &&
    selectedCard.assetIds.includes(selectedAssetId);
  const splitAsset = useCallback(
    (cardId: string, assetId: string) => {
      if (blocked || inactive || playing || document.saving || drag.drag)
        return;
      const card = cards.find((item) => item.id === cardId);
      if (!card || card.assetIds.length < 2 || !card.assetIds.includes(assetId))
        return;
      const patch = splitSelectedAsset(card, assetId, () =>
        crypto.randomUUID(),
      );
      void document.commit(patch).then((saved) => {
        if (saved)
          setSelection((current) =>
            current?.cardId === cardId && current.assetId === assetId
              ? { cardId, assetId: null }
              : current,
          );
      });
    },
    [
      blocked,
      inactive,
      playing,
      document.saving,
      document.commit,
      drag.drag,
      cards,
    ],
  );
  const split = () => {
    if (canSplit && selectedCard && selectedAssetId)
      splitAsset(selectedCard.id, selectedAssetId);
  };
  useCanvasShortcuts({
    shortcuts: interactions.shortcuts,
    disabled:
      blocked || inactive || document.saving || !!drag.drag || !!playing,
    cancel: () => {
      if (!drag.cancel()) setSelection(null);
    },
    actions: {
      play: selectedCard ? () => play(selectedCard.id) : null,
      split: canSplit ? split : null,
      undo: document.canUndo ? document.undo : null,
      redo: document.canRedo ? document.redo : null,
    },
  });
  const canHold =
    interactions.longPressSplit &&
    !blocked &&
    !inactive &&
    !document.saving &&
    !playing;

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
          splitAsset,
          canHold,
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
      splitAsset,
      canHold,
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
        nodeDragThreshold={DRAG_THRESHOLD}
        panActivationKeyCode={null}
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
        onNodeDoubleClick={(event, node) => {
          event.preventDefault();
          if (!inactive && !drag.drag && !document.saving) play(node.id);
        }}
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
            canSplit={canSplit}
            shortcuts={interactions.shortcuts}
            isMac={isMac}
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
                  ? '拖动拼接 · 双击播放' +
                    (interactions.longPressSplit ? ' · 长按片段后松开拆分' : '')
                  : '拖动卡片排列 · 双击放大播放'}
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
