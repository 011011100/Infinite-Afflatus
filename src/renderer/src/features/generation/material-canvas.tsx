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
  Sparkles,
  Type,
  Ungroup,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CanvasControls } from '@/components/canvas/canvas-controls';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { isMac } from '@/lib/platform';
import type { ShotWorkspace } from '../../../../shared/generation/workspace';
import type { ProjectSnapshot } from '../../../../shared/models';
import { GenerationGroupCard } from './generation-group';
import { MaterialCard } from './material-node';
import { MaterialSelectionFrame } from './material-selection-frame';
import { ReferencePicker } from './reference-picker';
import { useMaterialActions } from './use-material-actions';
import { type MaterialCanvasNode, useMaterialFlow } from './use-material-flow';
import { useMaterialSelection } from './use-material-selection';
import './generation.css';

const nodeTypes = {
  material: MaterialCard,
  generationGroup: GenerationGroupCard,
};
const edges: Edge[] = [];
export function MaterialCanvas({
  shot,
  snapshot,
  blocked,
  saving,
  error,
  onChange,
  onClose,
  retry,
}: {
  shot: ShotWorkspace;
  snapshot: ProjectSnapshot;
  blocked: boolean;
  saving: boolean;
  error: string | null;
  onChange: (change: (shot: ShotWorkspace) => ShotWorkspace) => void;
  onClose: () => Promise<void>;
  retry: () => Promise<boolean>;
}) {
  const flow = useRef<ReactFlowInstance<MaterialCanvasNode> | null>(null);
  const page = useRef<HTMLElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const [picker, setPicker] = useState(false);
  const [closing, setClosing] = useState(false);
  const model = useMaterialFlow(
    shot,
    snapshot.assets,
    snapshot.project.id,
    blocked,
    onChange,
  );
  const selection = useMaterialSelection(
    area,
    flow,
    model.selected,
    model.setSelected,
  );
  const {
    addText,
    addAssets,
    importFiles,
    importing,
    localError,
    setLocalError,
  } = useMaterialActions(
    shot,
    snapshot.project.id,
    flow,
    area,
    onChange,
    model.setSelected,
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
  const framedGroup = useRef<string | null>(null);
  useEffect(() => {
    if (framedGroup.current === model.activeGroup) return;
    framedGroup.current = model.activeGroup;
    const group = shot.groups.find((item) => item.id === model.activeGroup);
    if (group)
      void flow.current?.fitBounds(
        {
          x: group.position.x,
          y: group.position.y - 72,
          width: group.width + 296,
          height: Math.max(group.height, 620) + 72,
        },
        {
          padding: 0.12,
          duration: window.matchMedia('(prefers-reduced-motion: reduce)')
            .matches
            ? 0
            : 180,
        },
      );
  }, [model.activeGroup, shot.groups]);
  const close = async () => {
    if (closing || importing) return;
    setClosing(true);
    await onClose();
    setClosing(false);
  };
  const selectedGroup = shot.groups.find((group) =>
    model.selected.includes(group.id),
  );
  const disabled = blocked || importing || closing;
  return createPortal(
    <section
      ref={page}
      tabIndex={-1}
      aria-label={`${shot.name}素材子画布`}
      className="fixed inset-0 z-50 flex min-h-0 flex-col bg-canvas outline-none"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background px-5">
        <Button
          variant="ghost"
          disabled={importing || closing}
          onClick={() => void close()}
        >
          <ArrowLeft />
          返回主画布
        </Button>
        <span className="h-4 border-l" />
        <span className="max-w-52 truncate text-sm">{shot.name}</span>
        <span className="text-xs text-muted-foreground">素材画布</span>
        <span
          className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground"
          role="status"
        >
          {saving && <LoaderCircle className="size-3 animate-spin" />}
          {blocked
            ? '迁移中'
            : error
              ? '保存失败'
              : saving
                ? '保存中…'
                : '已保存'}
        </span>
      </header>
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
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setLocalError(null)}
            >
              关闭提示
            </Button>
          )}
        </div>
      )}
      <ContextMenu open={selection.open} onOpenChange={selection.onOpenChange}>
        <ContextMenuTrigger
          ref={area}
          className="relative min-h-0 flex-1"
          onPointerDownCapture={selection.onPointerDownCapture}
          onContextMenuCapture={selection.onContextMenuCapture}
        >
          <ReactFlow
            nodes={model.nodes}
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
            onNodesChange={model.onChanges}
            onNodeDragStop={model.finishMove}
            onSelectionDragStop={(event, nodes) => {
              if (nodes[0]) model.finishMove(event, nodes[0], nodes);
            }}
            onPaneClick={() => {
              model.setSelected([]);
              model.setActiveGroup(null);
            }}
            onMoveEnd={(_event, viewport) =>
              onChange((current) => ({ ...current, viewport }))
            }
          >
            <MaterialSelectionFrame dragging={selection.box !== null} />
            <Background
              variant={BackgroundVariant.Dots}
              gap={24}
              size={1}
              color="var(--canvas-dot)"
            />
            <CanvasControls />
            <Panel position="top-left">
              <div className="flex gap-1 rounded-xl border bg-background p-1.5 shadow-sm">
                <Button variant="ghost" disabled={disabled} onClick={addText}>
                  <Type />
                  文本
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
            {!!model.freeIds.length && (
              <Panel position="bottom-center">
                <Button
                  className="shadow-md"
                  disabled={disabled || model.freeIds.length > 32}
                  onClick={model.group}
                >
                  <Sparkles />
                  生成视频
                  <span className="ml-1 opacity-70">
                    {model.freeIds.length}
                  </span>
                </Button>
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
          {!shot.nodes.length && (
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
          <ContextMenuItem
            disabled={
              disabled || !model.freeIds.length || model.freeIds.length > 32
            }
            onClick={model.group}
          >
            <Sparkles />
            生成视频
          </ContextMenuItem>
          {selectedGroup && (
            <>
              <ContextMenuItem
                onClick={() => model.setActiveGroup(selectedGroup.id)}
              >
                生成参数
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
    </section>,
    document.body,
  );
}
