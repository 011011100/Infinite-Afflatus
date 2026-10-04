import {
  Background,
  BackgroundVariant,
  type Edge,
  Panel,
  ReactFlow,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  ArrowLeft,
  FolderOpen,
  LoaderCircle,
  Plus,
  Tag,
  Type,
  Ungroup,
  Upload,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CanvasControls } from '@/components/canvas/canvas-controls';
import { HistoryActions } from '@/components/canvas/history-actions';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { usePageMotion } from '@/components/ui/use-surface-motion';
import {
  capturePendingSaves,
  flushPendingChanges,
} from '@/features/lifecycle/pending-saves';
import { isMac } from '@/lib/platform';
import type {
  ShotHistoryActions,
  ShotUpdate,
} from '../../../../shared/generation/shot-history';
import type { ShotWorkspace } from '../../../../shared/generation/workspace';
import { defaultInteractionSettings } from '../../../../shared/interaction/settings';
import type {
  Shortcut,
  Shortcuts,
} from '../../../../shared/interaction/shortcuts';
import type { ProjectSnapshot } from '../../../../shared/models';
import { message } from './errors';
import { GenerationGroupCard } from './generation-group';
import { GroupStage } from './group-stage';
import { LabelCard } from './label-node';
import { LabelLocator } from './labels/label-locator';
import { useLabelFlight } from './labels/use-label-flight';
import { MaterialGenerationActions } from './material-generation-actions';
import { MaterialCard } from './material-node';
import { MaterialSelectionFrame } from './material-selection-frame';
import { ReferenceImportStatus } from './reference-import-status';
import type { ReferenceImportTarget } from './reference-import-target';
import { ReferencePicker } from './reference-picker';
import { useMaterialActions } from './use-material-actions';
import { type MaterialCanvasNode, useMaterialFlow } from './use-material-flow';
import { useMaterialGroupHover } from './use-material-group-hover';
import { useMaterialHistory } from './use-material-history';
import { useMaterialSelection } from './use-material-selection';
import { useMaterialViewport } from './use-material-viewport';
import './generation.css';

const nodeTypes = {
  material: MaterialCard,
  label: LabelCard,
  generationGroup: GenerationGroupCard,
};
const edges: Edge[] = [];
export function MaterialCanvas({
  shot,
  snapshot,
  blocked,
  projectUnavailable,
  unavailableNotice,
  longPressSplit,
  labelShortcut = defaultInteractionSettings().shortcuts.locateLabels,
  shortcuts = defaultInteractionSettings().shortcuts,
  history,
  saving,
  recovering = false,
  error,
  onChange,
  beginImport,
  onClose,
  beforeClose,
  retry,
}: {
  shot: ShotWorkspace;
  snapshot: ProjectSnapshot;
  blocked: boolean;
  projectUnavailable?: boolean | undefined;
  unavailableNotice?: ReactNode;
  longPressSplit: boolean;
  labelShortcut?: Shortcut | null;
  shortcuts?: Shortcuts;
  history?: ShotHistoryActions;
  saving: boolean;
  recovering?: boolean;
  error: string | null;
  onChange: ShotUpdate;
  beginImport?: () => ReferenceImportTarget | null;
  onClose: () => void;
  beforeClose: () => Promise<boolean>;
  retry: () => Promise<boolean>;
}) {
  const flow = useRef<ReactFlowInstance<MaterialCanvasNode> | null>(null);
  const page = useRef<HTMLElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [picker, setPicker] = useState(false);
  const { closing, requestClose } = usePageMotion(page, onClose, async () => {
    let token: string | null = null;
    const captured = capturePendingSaves();
    try {
      token = await window.desktop.prepareReferenceImportsForLeave();
      const completed = await captured;
      const flushed = await flushPendingChanges();
      if (!completed || !flushed) return false;
      return await beforeClose();
    } catch (reason) {
      setLocalError(message(reason));
      return false;
    } finally {
      if (token) {
        try {
          await window.desktop.resumeReferenceSaves(token);
        } catch (reason) {
          setLocalError(message(reason));
        }
      }
    }
  });
  const model = useMaterialFlow(
    shot,
    snapshot.assets,
    snapshot.project.id,
    blocked,
    longPressSplit,
    onChange,
  );
  const navigation = useLabelFlight(flow, area, (viewport) =>
    onChange((current) => ({ ...current, viewport })),
  );
  const selection = useMaterialSelection(
    area,
    flow,
    model.selected,
    model.setSelected,
  );
  const {
    addText,
    addLabel,
    addAssets,
    importFiles,
    cancelImport,
    importing,
    progress,
    notice,
    dismissNotice,
    pendingAssets,
    retryAdding,
    localError,
    setLocalError,
  } = useMaterialActions(
    shot,
    snapshot.project.id,
    flow,
    area,
    onChange,
    model.setSelected,
    blocked,
    beginImport,
  );
  useEffect(() => {
    const root = document.getElementById('root');
    const focused = document.activeElement;
    if (root) root.inert = true;
    page.current?.focus();
    return () => {
      if (root) root.inert = false;
      if (focused instanceof HTMLElement && focused.isConnected)
        focused.focus({ preventScroll: true });
    };
  }, []);
  useMaterialViewport(flow, area, model.activeGroup, model.detached);
  const close = async () => {
    if (recovering) return;
    navigation.cancel();
    await requestClose();
  };
  const selectedGroup = shot.groups.find((group) =>
    model.selected.includes(group.id),
  );
  const selectedMaterial =
    model.selected.length === 1
      ? shot.nodes.find((node) => node.id === model.selected[0] && node.groupId)
      : undefined;
  const disabled = blocked || importing || closing || pendingAssets;
  const groupActions = {
    count: model.grouping.materials.length,
    hasGroups: model.grouping.groups.length > 0,
    canGroup: model.grouping.canGroup,
    imageError: model.grouping.imageError,
    groupError: model.grouping.groupError,
    disabled,
    group: model.group,
  };
  const editingGroup = shot.groups.find(
    (group) => group.id === model.activeGroup,
  );
  const hoverGroup = useMaterialGroupHover({
    shot,
    assets: snapshot.assets,
    disabled: disabled || picker || !!editingGroup,
    flow,
    area,
    join: model.join,
    onChanges: model.onChanges,
    finishMove: model.finishMove,
  });
  const undoRedo = useMaterialHistory(
    page,
    history,
    shortcuts,
    disabled || picker || selection.open,
    () => {
      navigation.cancel();
      model.resetTransient();
    },
  );
  const historyActions = history
    ? { ...history, undo: undoRedo.undo, redo: undoRedo.redo }
    : undefined;
  return createPortal(
    <section
      ref={page}
      tabIndex={-1}
      aria-label={`${shot.name}素材子画布`}
      className="fixed inset-0 z-50 flex min-h-0 flex-col bg-canvas outline-none"
      onPointerDownCapture={undoRedo.onPointerDownCapture}
      onBlurCapture={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest(
            'input, textarea, select, [contenteditable="true"]',
          )
        )
          history?.breakMerge?.();
      }}
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-5">
        <Button
          variant="ghost"
          disabled={closing || recovering}
          onClick={() => void close()}
        >
          <ArrowLeft />
          返回主画布
        </Button>
        <span className="h-4 border-l" />
        <span className="max-w-52 truncate text-sm">{shot.name}</span>
        <span className="text-xs text-muted-foreground">素材画布</span>
        {historyActions && (
          <fieldset
            className="ml-1 flex items-center gap-1 border-l pl-2"
            aria-label="素材撤销操作"
          >
            <HistoryActions
              {...historyActions}
              disabled={disabled || picker || !!editingGroup}
              shortcuts={shortcuts}
              isMac={isMac}
            />
          </fieldset>
        )}
        <span
          className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"
          role="status"
        >
          {saving && <LoaderCircle className="size-3 animate-spin" />}
          {recovering
            ? '正在恢复镜头草稿…'
            : blocked
              ? projectUnavailable
                ? '项目不可用，未保存输入仍在本页'
                : '迁移中'
              : error
                ? '保存失败'
                : saving
                  ? '保存中…'
                  : '已保存'}
        </span>
      </header>
      {unavailableNotice}
      <ReferenceImportStatus
        progress={progress}
        notice={notice}
        cancel={cancelImport}
        dismiss={dismissNotice}
      />
      {(error || localError) && (
        <div
          role="alert"
          className="flex items-center gap-3 bg-warning px-5 py-2 text-xs text-warning-foreground"
        >
          <span className="flex-1 whitespace-pre-wrap">
            {error || localError}
          </span>
          {error && (
            <Button size="xs" variant="ghost" onClick={() => void retry()}>
              重试保存
            </Button>
          )}
          {localError && (
            <>
              {pendingAssets && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void retryAdding()}
                >
                  重试添加素材
                </Button>
              )}
              {!pendingAssets && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setLocalError(null)}
                >
                  关闭提示
                </Button>
              )}
            </>
          )}
        </div>
      )}
      <ContextMenu open={selection.open} onOpenChange={selection.onOpenChange}>
        <ContextMenuTrigger
          ref={area}
          className="relative min-h-0 flex-1"
          onPointerDownCapture={(event) => {
            navigation.cancel();
            selection.onPointerDownCapture(event);
          }}
          onWheelCapture={navigation.cancel}
          onContextMenuCapture={selection.onContextMenuCapture}
        >
          <ReactFlow<MaterialCanvasNode>
            nodes={model.nodes.map((node) =>
              node.type === 'generationGroup'
                ? {
                    ...node,
                    data: {
                      ...node.data,
                      receiving: hoverGroup.groupId === node.id,
                    },
                  }
                : node,
            )}
            edges={edges}
            nodeTypes={nodeTypes}
            defaultViewport={shot.viewport}
            onInit={(instance) => {
              flow.current = instance;
            }}
            minZoom={0.25}
            maxZoom={2}
            nodesConnectable={false}
            nodesDraggable={!disabled}
            selectionOnDrag={false}
            panOnDrag={[0, 1]}
            panActivationKeyCode="Space"
            selectionKeyCode={null}
            multiSelectionKeyCode={isMac ? 'Meta' : 'Control'}
            deleteKeyCode={null}
            zoomOnDoubleClick={false}
            nodeDragThreshold={5}
            autoPanOnNodeDrag={!hoverGroup.ready}
            onNodesChange={hoverGroup.changes}
            onNodeDragStart={hoverGroup.start}
            onNodeDragStop={hoverGroup.finish}
            onSelectionDragStart={(event, nodes) => {
              if (nodes[0]) hoverGroup.start(event, nodes[0], nodes);
            }}
            onSelectionDragStop={(event, nodes) => {
              if (nodes[0]) hoverGroup.finish(event, nodes[0], nodes);
            }}
            onPaneClick={() => {
              model.setSelected([]);
              model.setActiveGroup(null);
            }}
            onMoveEnd={(_event, viewport) => {
              if (!navigation.moving.current)
                onChange((current) => ({ ...current, viewport }));
            }}
          >
            <MaterialSelectionFrame dragging={selection.box !== null} />
            <Background
              variant={BackgroundVariant.Dots}
              gap={24}
              size={1}
              color="var(--canvas-dot)"
            />
            <CanvasControls />
            <LabelLocator
              labels={shot.labels ?? []}
              shortcut={labelShortcut}
              disabled={disabled || picker || !!editingGroup}
              jump={navigation.jump}
              cancel={navigation.cancel}
            />
            <Panel position="top-left">
              <div className="flex gap-1 rounded-xl border bg-background p-1.5 shadow-sm">
                <Button variant="ghost" disabled={disabled} onClick={addText}>
                  <Type />
                  文本
                </Button>
                <Button variant="ghost" disabled={disabled} onClick={addLabel}>
                  <Tag />
                  标签
                </Button>
                <Button
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => void importFiles()}
                >
                  {importing ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Upload />
                  )}
                  导入素材
                </Button>
                <Button
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => setPicker(true)}
                >
                  <FolderOpen />
                  项目素材
                </Button>
              </div>
            </Panel>
            {model.grouping.materials.length > 0 &&
              (model.grouping.canGroup ||
                model.grouping.groupError ||
                model.grouping.materials.length > 32) && (
                <Panel position="bottom-center">
                  <MaterialGenerationActions {...groupActions} />
                </Panel>
              )}
          </ReactFlow>
          {selection.box && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute z-30 rounded-sm border border-primary bg-primary/10"
              style={{
                left: selection.box.x,
                top: selection.box.y,
                width: selection.box.width,
                height: selection.box.height,
              }}
            />
          )}
          {!shot.nodes.length && !shot.labels?.length && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="pointer-events-auto flex gap-3">
                <Button
                  variant="outline"
                  className="h-12 bg-background px-5 shadow-sm"
                  disabled={disabled}
                  onClick={addText}
                >
                  <Plus />
                  文本卡片
                </Button>
                <Button
                  variant="outline"
                  className="h-12 bg-background px-5 shadow-sm"
                  disabled={disabled}
                  onClick={() => void importFiles()}
                >
                  <Upload />
                  图片 / 视频 / 音频
                </Button>
              </div>
            </div>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <MaterialGenerationActions menu {...groupActions} />
          {selectedMaterial && (
            <ContextMenuItem
              disabled={disabled}
              onClick={() => model.detach(selectedMaterial.id)}
            >
              <Ungroup />
              拆出卡片
            </ContextMenuItem>
          )}
          {selectedGroup && (
            <>
              <ContextMenuItem
                onClick={() => model.setActiveGroup(selectedGroup.id)}
              >
                展开编辑
              </ContextMenuItem>
              <ContextMenuItem
                disabled={disabled}
                onClick={() => model.ungroup(selectedGroup.id)}
              >
                <Ungroup />
                解除生成组
              </ContextMenuItem>
            </>
          )}
          <ContextMenuItem disabled={disabled} onClick={addText}>
            <Type />
            添加文本
          </ContextMenuItem>
          <ContextMenuItem disabled={disabled} onClick={addLabel}>
            <Tag />
            添加标签
          </ContextMenuItem>
          <ContextMenuItem
            disabled={disabled}
            onClick={() => void importFiles()}
          >
            <Upload />
            导入素材
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {picker && (
        <ReferencePicker
          projectId={snapshot.project.id}
          assets={snapshot.assets}
          selectedIds={[]}
          remaining={24}
          onAdd={addAssets}
          onClose={() => setPicker(false)}
        />
      )}
      {editingGroup && (
        <GroupStage
          key={editingGroup.id}
          shot={shot}
          group={editingGroup}
          assets={snapshot.assets}
          projectId={snapshot.project.id}
          disabled={disabled}
          saving={saving}
          recovering={recovering}
          error={error}
          unavailableNotice={unavailableNotice}
          update={onChange}
          history={historyActions}
          onClose={() => model.setActiveGroup(null)}
          detach={(id, at) =>
            model.detach(
              id,
              at ? flow.current?.screenToFlowPosition(at) : undefined,
            )
          }
          origin={() => {
            const point =
              flow.current?.flowToScreenPosition(editingGroup.position) ??
              editingGroup.position;
            const zoom = flow.current?.getZoom() ?? 1;
            return {
              ...point,
              width: editingGroup.width * zoom,
              height: editingGroup.height * zoom,
            };
          }}
        />
      )}
    </section>,
    document.body,
  );
}
