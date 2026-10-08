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
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { CanvasControls } from '@/components/canvas/canvas-controls';
import { HoldFeedbackProvider } from '@/components/canvas/hold-feedback';
import { Button } from '@/components/ui/button';
import { projectEditRecoveryGuards } from '@/features/drafts/project-edit-recovery-guards';
import { TrimProtectionNotice } from '@/features/drafts/trim-protection-notice';
import { WorkspaceDraftNotice } from '@/features/drafts/workspace-draft-notice';
import { MaterialCanvas } from '@/features/generation/material-canvas';
import { ShotCard, type ShotCardNode } from '@/features/generation/shot-card';
import { useShotWorkspace } from '@/features/generation/use-shot-workspace';
import { isMac } from '@/lib/platform';
import { MainCanvasHistory } from '../../../../shared/canvas/main-history';
import { CARD_HEIGHT, cardWidth } from '../../../../shared/canvas/model';
import { splitSelectedAsset } from '../../../../shared/canvas/operations';
import { MAX_SHOTS } from '../../../../shared/generation/shot-duplication';
import { DRAG_THRESHOLD } from '../../../../shared/interaction/long-press';
import type { InteractionSettings } from '../../../../shared/interaction/settings';
import type { Asset, ProjectSnapshot } from '../../../../shared/models';
import { CanvasActions } from './canvas-actions';
import { SequenceEditor } from './editor/sequence-editor';
import { useCardMorph } from './motion/use-card-morph';
import {
  ThumbnailActivityContext,
  ThumbnailProvider,
} from './thumbnail-provider';
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
  projectUnavailable?: boolean;
  unavailableNotice?: ReactNode;
  interactions: InteractionSettings;
  inactive: boolean;
  report: (error: unknown) => void;
  onOpenArkSettings?: () => void;
  onAdoptedProject?: (snapshot: ProjectSnapshot) => Promise<void>;
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
  projectUnavailable,
  unavailableNotice,
  interactions,
  inactive,
  report,
  onOpenArkSettings,
  onAdoptedProject,
}: ProjectCanvasProps) {
  const [mainHistory] = useState(() => new MainCanvasHistory());
  const mainState = useSyncExternalStore(
    mainHistory.subscribe,
    mainHistory.getSnapshot,
  );
  const shots = useShotWorkspace(
    snapshot.project.id,
    blocked,
    report,
    mainHistory,
  );
  const interactionBlocked = blocked || shots.recovering || shots.adopting;
  const isRecovering = useCallback(
    () =>
      shots.isRecovering() ||
      shots.isAdopting() ||
      projectEditRecoveryGuards.isRecovering(snapshot.project.id),
    [shots.isRecovering, shots.isAdopting, snapshot.project.id],
  );
  const recoveryNotice = (
    <WorkspaceDraftNotice
      recovery={shots.recovery}
      baseline={shots.baseline}
      dirty={shots.dirty}
      blocked={blocked}
      editorBusy={mainState.busy || shots.adopting}
      saveFailed={!!shots.error}
      recovering={shots.recovering}
      restore={(record) => {
        if (!projectEditRecoveryGuards.isRecovering(snapshot.project.id))
          return shots.recoverDraft(record);
        return Promise.resolve(false);
      }}
    />
  );
  const saveViewport = useViewportSave(
    snapshot.project.id,
    interactionBlocked,
    report,
  );
  const [shotPositions, setShotPositions] = useState<
    Record<string, { x: number; y: number }>
  >({});
  const root = useRef<HTMLElement | null>(null);
  const prepareTransition = useCardMorph(
    root,
    interactionBlocked || inactive || !!shots.activeId,
  );
  const document = useCanvasDocument(
    snapshot,
    interactionBlocked,
    report,
    prepareTransition,
    mainHistory,
  );
  const structureBlocked =
    interactionBlocked || mainState.busy || !document.canRecoverProjectEdits();
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
  const nextShotPosition = () => ({
    x: 100,
    y: Math.max(
      60,
      ...cards.map((card) => card.position.y + CARD_HEIGHT + 48),
      ...shots.shots
        .filter((shot) => !shot.sourceAssetId)
        .map((shot) => shot.position.y + CARD_HEIGHT + 48),
    ),
  });
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
  const drag = useCardDrag(
    cards,
    interactionBlocked,
    document.commit,
    selectCard,
  );
  const recoveryState = useRef({ document, shots, drag, shotPositions });
  recoveryState.current = { document, shots, drag, shotPositions };
  useLayoutEffect(
    () =>
      projectEditRecoveryGuards.register(
        snapshot.project.id,
        () => {
          const current = recoveryState.current;
          return (
            current.document.canRecoverProjectEdits() &&
            !mainHistory.getSnapshot().busy &&
            !current.shots.isRecovering() &&
            !current.shots.isAdopting() &&
            !current.drag.drag &&
            Object.keys(current.shotPositions).length === 0
          );
        },
        (record, saved) =>
          recoveryState.current.document.acceptRecoveredEdit(record, saved),
        (record) => recoveryState.current.document.prepareRecoveredEdit(record),
      ),
    [snapshot.project.id, mainHistory],
  );
  useEffect(
    () =>
      document.trimRecovery.subscribe(() => projectEditRecoveryGuards.notify()),
    [document.trimRecovery],
  );
  useEffect(() => {
    projectEditRecoveryGuards.notify();
  });
  const trimNotice = (
    <TrimProtectionNotice
      projectId={snapshot.project.id}
      controller={document.trimRecovery}
      error={document.trimRecoveryError}
    />
  );
  const play = useCallback(
    (id: string) => {
      if (structureBlocked || inactive || isRecovering()) return;
      const card = cards.find((item) => item.id === id);
      if (card) {
        selectCard(id);
        setPlaying(id);
      }
    },
    [cards, selectCard, structureBlocked, inactive, isRecovering],
  );
  const selectedCard = cards.find((card) => card.id === selection?.cardId);
  const selectedShot = shots.shots.find(
    (shot) => !shot.sourceAssetId && selection?.cardId === `shot:${shot.id}`,
  );
  const selectedAssetId = selection?.assetId;
  const canSplit =
    !!selectedCard &&
    selectedCard.assetIds.length > 1 &&
    !!selectedAssetId &&
    selectedCard.assetIds.includes(selectedAssetId);
  const splitAsset = useCallback(
    (cardId: string, assetId: string) => {
      if (
        structureBlocked ||
        isRecovering() ||
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
      structureBlocked,
      isRecovering,
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
  const changeHistory = async (direction: 'undo' | 'redo') => {
    if (
      structureBlocked ||
      inactive ||
      shots.activeId ||
      playing ||
      drag.drag ||
      isRecovering()
    )
      return;
    const operation = mainHistory.getSnapshot()[direction];
    if (!operation) return;
    if (operation.kind === 'video') {
      if (await document.commit(operation.patch, direction)) {
        const id = operation.patch.after[0]?.id;
        setSelection(id ? { cardId: id, assetId: null } : null);
      }
      return;
    }
    if (!(await shots.applyListOperation(operation.operation, direction)))
      return;
    const action = operation.operation;
    if (action.type === 'remove') setSelection(null);
    else {
      const id = action.type === 'insert' ? action.shot.id : action.id;
      const position =
        action.type === 'insert' ? action.shot.position : action.to;
      setSelection({ cardId: `shot:${id}`, assetId: null });
      void flow.current?.setCenter(
        position.x + 144,
        position.y + CARD_HEIGHT / 2,
        { zoom: 1 },
      );
    }
  };
  const removeShot = async () => {
    if (
      !selectedShot ||
      structureBlocked ||
      inactive ||
      shots.activeId ||
      playing ||
      drag.drag ||
      isRecovering()
    )
      return;
    if (await shots.applyListOperation({ type: 'remove', id: selectedShot.id }))
      setSelection(null);
  };
  useCanvasShortcuts({
    shortcuts: interactions.shortcuts,
    disabled:
      structureBlocked ||
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
      undo: mainState.undo ? () => void changeHistory('undo') : null,
      redo: mainState.redo ? () => void changeHistory('redo') : null,
    },
  });
  const canHold =
    interactions.longPressSplit &&
    !structureBlocked &&
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
          canOpenMaterials: shots.loaded && !structureBlocked,
          disabled: structureBlocked || inactive,
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
            disabled: structureBlocked || inactive,
            open: () => {
              if (!mainHistory.getSnapshot().busy) shots.open(shot.id);
            },
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
      structureBlocked,
      mainHistory,
      inactive,
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
      aria-busy={mainState.busy || shots.recovering || shots.adopting}
    >
      {!shots.activeShot && !playing && (
        <div className="absolute inset-x-0 top-0 z-20">
          {shots.error && (
            <div
              role="alert"
              className="flex items-center gap-3 border-b bg-warning px-4 py-3 text-xs text-warning-foreground"
            >
              <span className="min-w-0 flex-1 whitespace-pre-wrap">
                {shots.error}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label="重试镜头数据"
                disabled={blocked || shots.recovering}
                onClick={() => void shots.retry()}
              >
                <RotateCw />
                重试保存
              </Button>
            </div>
          )}
          {recoveryNotice}
          {trimNotice}
        </div>
      )}
      <ThumbnailActivityContext value={!playing && !shots.activeId}>
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
          nodesDraggable={!structureBlocked}
          nodeDragThreshold={DRAG_THRESHOLD}
          panActivationKeyCode={null}
          nodeClickDistance={5}
          deleteKeyCode={null}
          multiSelectionKeyCode={null}
          selectionKeyCode={null}
          disableKeyboardA11y
          zoomOnDoubleClick={false}
          panOnDrag={!interactionBlocked}
          zoomOnScroll={!interactionBlocked}
          zoomOnPinch={!interactionBlocked}
          onNodesChange={(changes) => {
            for (const change of changes) {
              if (
                change.type === 'position' &&
                !structureBlocked &&
                !isRecovering() &&
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
            if (
              structureBlocked ||
              isRecovering() ||
              inactive ||
              drag.drag ||
              document.saving
            )
              return;
            if (node.type === 'shot') shots.open(node.id.slice(5));
            else play(node.id);
          }}
          onNodeDragStart={(_event, node) => {
            if (structureBlocked || isRecovering()) return;
            if (node.type === 'video') drag.start(node.id);
          }}
          onNodeDrag={(_event, node) =>
            node.type === 'video' &&
            drag.move(node.position, flow.current?.getZoom() ?? 1)
          }
          onNodeDragStop={(_event, node) => {
            if (structureBlocked || isRecovering()) {
              setShotPositions({});
              return;
            }
            if (node.type === 'shot') {
              const shot = shots.shots.find(
                (item) => item.id === node.id.slice(5),
              );
              if (shot)
                void shots.applyListOperation({
                  type: 'move',
                  id: shot.id,
                  from: shot.position,
                  to: node.position,
                });
              setShotPositions({});
            } else void drag.stop(node.position, flow.current?.getZoom() ?? 1);
          }}
          onMoveEnd={(_event, viewport) => {
            if (!interactionBlocked && !isRecovering())
              void saveViewport(viewport);
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
          {!interactionBlocked && <CanvasControls />}
          <Panel position="top-left">
            <Button
              variant="outline"
              className="bg-background shadow-sm"
              disabled={
                structureBlocked ||
                !shots.loaded ||
                shots.shots.length >= MAX_SHOTS
              }
              title={
                shots.shots.length >= MAX_SHOTS
                  ? `项目最多容纳 ${MAX_SHOTS} 个镜头`
                  : undefined
              }
              onClick={() => {
                if (isRecovering()) return;
                const position = nextShotPosition();
                shots.create(position);
                void flow.current?.setCenter(
                  position.x + 144,
                  position.y + CARD_HEIGHT / 2,
                  { zoom: 1 },
                );
              }}
            >
              <Plus />
              新建镜头
            </Button>
          </Panel>
          <Panel position="bottom-center">
            <CanvasActions
              disabled={structureBlocked || inactive || !!drag.drag}
              canUndo={!!mainState.undo}
              canRedo={!!mainState.redo}
              canSplit={canSplit}
              canRemove={!!selectedShot}
              remove={() => void removeShot()}
              shortcuts={interactions.shortcuts}
              isMac={isMac}
              undo={() => void changeHistory('undo')}
              redo={() => void changeHistory('redo')}
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
            ) : mainState.busy ? (
              <p
                role="status"
                className="rounded-full bg-canvas/90 px-3 py-1.5 text-xs text-muted-foreground"
              >
                正在保存…
              </p>
            ) : null}
          </Panel>
        </ReactFlow>
      </ThumbnailActivityContext>
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
          shortcuts={interactions.shortcuts}
          history={shots.historyFor(shots.activeShot.id)}
          snapshot={document.snapshot}
          blocked={interactionBlocked}
          recovering={shots.recovering}
          adopting={shots.adopting}
          pendingAdoptionJobId={shots.pendingAdoptionJobId}
          onOpenArkSettings={onOpenArkSettings}
          onAdoptGeneration={(jobId) => {
            if (shots.isAdopting()) return shots.adoptGeneration(jobId);
            if (
              inactive ||
              isRecovering() ||
              drag.drag ||
              Object.keys(shotPositions).length ||
              !document.canRecoverProjectEdits()
            )
              return Promise.reject(
                new Error('请先完成当前编辑，再采用生成结果。'),
              );
            return shots.adoptGeneration(
              jobId,
              document.beginGenerationAdoption,
              onAdoptedProject,
            );
          }}
          projectUnavailable={projectUnavailable}
          unavailableNotice={
            <>
              {unavailableNotice}
              {recoveryNotice}
              {trimNotice}
            </>
          }
          saving={shots.saving}
          error={shots.error}
          onChange={(update, options) => {
            if (shots.activeId)
              shots.updateShot(shots.activeId, update, options);
          }}
          beginImport={() =>
            shots.activeId ? shots.beginReferenceImport(shots.activeId) : null
          }
          beforeClose={shots.flush}
          duplicatePending={shots.duplicatePending}
          onDuplicate={async () => {
            if (isRecovering() || !shots.activeId) return false;
            const copy = await shots.duplicate(
              shots.activeId,
              nextShotPosition(),
            );
            if (!copy) return false;
            void flow.current?.setCenter(
              copy.position.x + 144,
              copy.position.y + CARD_HEIGHT / 2,
              { zoom: 1 },
            );
            setSelection({ cardId: `shot:${copy.id}`, assetId: null });
            return true;
          }}
          onClose={shots.dismiss}
          retry={shots.retry}
        />
      )}
      {playingCard && (
        <SequenceEditor
          card={playingCard}
          assets={playingAssets}
          projectName={snapshot.project.name}
          blocked={interactionBlocked}
          projectUnavailable={projectUnavailable}
          unavailableNotice={
            <>
              {unavailableNotice}
              {trimNotice}
            </>
          }
          trimRecovery={document.trimRecovery}
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
