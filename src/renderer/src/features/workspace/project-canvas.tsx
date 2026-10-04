import {
  Background,
  BackgroundVariant,
  type Edge,
  Panel,
  ReactFlow,
  type ReactFlowInstance,
  ViewportPortal,
} from '@xyflow/react';
import { Plus, RotateCw } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { CanvasControls } from '@/components/canvas/canvas-controls';
import { HoldFeedbackProvider } from '@/components/canvas/hold-feedback';
import { Button } from '@/components/ui/button';
import { MaterialCanvas } from '@/features/generation/material-canvas';
import { ShotCard, type ShotCardNode } from '@/features/generation/shot-card';
import { useShotWorkspace } from '@/features/generation/use-shot-workspace';
import { isMac } from '@/lib/platform';
import { CARD_HEIGHT, cardWidth } from '../../../../shared/canvas/model';
import { splitSelectedAsset } from '../../../../shared/canvas/operations';
import { DRAG_THRESHOLD } from '../../../../shared/interaction/long-press';
import type { InteractionSettings } from '../../../../shared/interaction/settings';
import type { Asset, ProjectSnapshot } from '../../../../shared/models';
import { CanvasActions } from './canvas-actions';
import { SequenceEditor } from './editor/sequence-editor';
import { useCardMorph } from './motion/use-card-morph';
import { ThumbnailProvider } from './thumbnail-provider';
import { useCanvasDocument } from './use-canvas-document';
import { useCanvasShortcuts } from './use-canvas-shortcuts';
import { useCardDrag } from './use-card-drag';
import { useViewportSave } from './use-viewport-save';
import { VideoCard, type VideoCardNode } from './video-card';

const edges: Edge[] = [];
const nodeTypes = { video: VideoCard, shot: ShotCard };
type WorkspaceNode = VideoCardNode | ShotCardNode;
type ProjectCanvasProps = {
  snapshot: ProjectSnapshot;
  blocked: boolean;
  interactions: InteractionSettings;
  inactive: boolean;
  report: (error: unknown) => void;
};

export function ProjectCanvas(props: ProjectCanvasProps) {
  return (
    <ThumbnailProvider>
      <HoldFeedbackProvider>
        <CanvasContent {...props} />
      </HoldFeedbackProvider>
    </ThumbnailProvider>
  );
}

function CanvasContent({
  snapshot,
  blocked,
  interactions,
  inactive,
  report,
}: ProjectCanvasProps) {
  const shots = useShotWorkspace(snapshot.project.id, blocked);
  const saveViewport = useViewportSave(snapshot.project.id, report);
  const [shotPositions, setShotPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const root = useRef<HTMLElement | null>(null);
  const prepareTransition = useCardMorph(
    root,
    blocked || inactive || !!shots.activeId,
  );
  const document = useCanvasDocument(
    snapshot,
    blocked,
    report,
    prepareTransition,
  );
  const { cards } = document.snapshot.canvas;
  const [selection, setSelection] = useState<{
    cardId: string;
    assetId: string | null;
  } | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [measurements, setMeasurements] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const flow = useRef<ReactFlowInstance<WorkspaceNode> | null>(null);
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
        setPlaying(id);
      }
    },
    [cards, selectCard],
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
      if (
        blocked ||
        inactive ||
        shots.activeId ||
        playing ||
        document.saving ||
        drag.drag
      )
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
      shots.activeId,
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
      blocked ||
      inactive ||
      !!shots.activeId ||
      document.saving ||
      !!drag.drag ||
      !!playing,
    cancel: () => {
      if (!playing && !drag.cancel()) setSelection(null);
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
    !shots.activeId &&
    !document.saving &&
    !playing;

  const nodes = useMemo<WorkspaceNode[]>(
    () => [
      ...cards.map((card) => ({
        id: card.id,
        type: 'video' as const,
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
          trims: card.trims,
          activeAssetId:
            selection?.cardId === card.id ? selection.assetId : null,
          snapSide:
            drag.drag?.snap?.targetId === card.id ? drag.drag.snap.side : null,
          play,
          selectAsset,
          splitAsset,
          canHold,
          openMaterials: (assetId: string) => {
            const asset = assets.get(assetId);
            if (asset) shots.create(card.position, asset);
          },
          canOpenMaterials: shots.loaded && !blocked,
        },
      })),
      ...shots.shots
        .filter((shot) => !shot.sourceAssetId)
        .map((shot) => ({
          id: `shot:${shot.id}`,
          type: 'shot' as const,
          position: shotPositions[shot.id] ?? shot.position,
          selected: selection?.cardId === `shot:${shot.id}`,
          measured: { width: 288, height: CARD_HEIGHT },
          data: {
            name: shot.name,
            count: shot.nodes.length,
            open: () => shots.open(shot.id),
          },
        })),
    ],
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
      shots.shots,
      shots.create,
      shots.open,
      shots.loaded,
      blocked,
      shotPositions,
    ],
  );
  const playingCard = cards.find((card) => card.id === playing);
  const playingAssets = useMemo(
    () =>
      playingCard?.assetIds
        .map((id) => assets.get(id))
        .filter((asset): asset is Asset => !!asset) ?? [],
    [playingCard?.assetIds, assets],
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
      ref={root}
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
            if (
              change.type === 'position' &&
              change.position &&
              change.id.startsWith('shot:')
            ) {
              const position = change.position;
              setShotPositions((current) => ({
                ...current,
                [change.id.slice(5)]: position,
              }));
            }
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
          if (inactive || drag.drag || document.saving) return;
          if (node.type === 'shot') shots.open(node.id.slice(5));
          else play(node.id);
        }}
        onNodeDragStart={(_event, node) => {
          if (node.type === 'video') drag.start(node.id);
        }}
        onNodeDrag={(_event, node) =>
          node.type === 'video' &&
          drag.move(node.position, flow.current?.getZoom() ?? 1)
        }
        onNodeDragStop={(_event, node) => {
          if (node.type === 'shot') {
            shots.updateShot(node.id.slice(5), (shot) => ({
              ...shot,
              position: node.position,
            }));
            setShotPositions({});
          } else void drag.stop(node.position, flow.current?.getZoom() ?? 1);
        }}
        onMoveEnd={(_event, viewport) => {
          if (!blocked) void saveViewport(viewport);
        }}
      >
        <ViewportPortal>
          <svg
            data-card-liquid-layer
            className="card-liquid-layer"
            aria-hidden="true"
          />
        </ViewportPortal>
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="var(--canvas-dot)"
        />
        {!blocked && <CanvasControls />}
        <Panel position="top-left">
          <Button
            variant="outline"
            className="bg-background shadow-sm"
            disabled={blocked || !shots.loaded}
            onClick={() => {
              const bottom = Math.max(
                60,
                ...cards.map((card) => card.position.y + CARD_HEIGHT + 48),
                ...shots.shots
                  .filter((shot) => !shot.sourceAssetId)
                  .map((shot) => shot.position.y + CARD_HEIGHT + 48),
              );
              shots.create({ x: 100, y: bottom });
              void flow.current?.setCenter(244, bottom + CARD_HEIGHT / 2, {
                zoom: 1,
              });
            }}
          >
            <Plus />
            新建镜头
          </Button>
        </Panel>
        {shots.error && (
          <Panel position="top-right">
            <div
              role="alert"
              className="flex items-center gap-2 rounded-lg bg-warning p-3 text-xs text-warning-foreground"
            >
              {shots.error}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="重试镜头数据"
                onClick={() => void shots.retry()}
              >
                <RotateCw />
              </Button>
            </div>
          </Panel>
        )}
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
          ) : document.saving ? (
            <p
              role="status"
              className="rounded-full bg-canvas/90 px-3 py-1.5 text-xs text-muted-foreground"
            >
              正在保存…
            </p>
          ) : null}
        </Panel>
      </ReactFlow>
      {!nodes.length && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-muted-foreground select-none">
          <h1 className="mb-2.5 text-xl font-medium">从一个镜头开始</h1>
          <p className="text-sm">新建镜头，或导入一段视频</p>
        </div>
      )}
      {shots.activeShot && (
        <MaterialCanvas
          key={`materials:${shots.activeShot.id}`}
          shot={shots.activeShot}
          longPressSplit={interactions.longPressSplit}
          labelShortcut={interactions.shortcuts.locateLabels}
          snapshot={document.snapshot}
          blocked={blocked}
          saving={shots.saving}
          error={shots.error}
          onChange={(update) => {
            if (shots.activeId) shots.updateShot(shots.activeId, update);
          }}
          beforeClose={shots.flush}
          onClose={shots.dismiss}
          retry={shots.retry}
        />
      )}
      {playingCard && (
        <SequenceEditor
          card={playingCard}
          assets={playingAssets}
          projectName={snapshot.project.name}
          blocked={blocked}
          saving={document.saving}
          shortcuts={interactions.shortcuts}
          canUndo={
            document.canUndoTrim && document.undoCardId === playingCard.id
          }
          canRedo={
            document.canRedoTrim && document.redoCardId === playingCard.id
          }
          undo={document.undo}
          redo={document.redo}
          commit={document.commit}
          projectId={snapshot.project.id}
          onClose={() => setPlaying(null)}
        />
      )}
    </main>
  );
}
