import { ArrowLeft, Check, LoaderCircle } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { HistoryActions } from '@/components/canvas/history-actions';
import { Button } from '@/components/ui/button';
import { flushPendingChanges } from '@/features/lifecycle/pending-saves';
import { isMac } from '@/lib/platform';
import {
  appendGroupText,
  editMaterialText,
  reorderGroupMembers,
} from '../../../../shared/generation/group-editing';
import { imageReferenceCount } from '../../../../shared/generation/image-generation';
import type {
  ShotHistoryActions,
  ShotUpdate,
} from '../../../../shared/generation/shot-history';
import type {
  GenerationGroup,
  ShotWorkspace,
} from '../../../../shared/generation/workspace';
import type { Asset } from '../../../../shared/models';
import { ArkGenerationControls } from './ark/ark-generation-controls';
import { useArkGeneration } from './ark/use-ark-generation';
import { GenerationSettings } from './generation-parameters';
import { GroupTextStack } from './group-text-stack';
import { ImageGenerationSettings } from './image-generation-parameters';
import { MaterialArc } from './material-arc';
import { useGroupStageMotion } from './use-group-stage-motion';
import './group-stage.css';

const parameterMergeKey = (id: string, before: object, after: object) =>
  `parameters:${id}:${Object.entries(after)
    .filter(([key, value]) => Reflect.get(before, key) !== value)
    .map(([key]) => key)
    .sort()
    .join(',')}`;

export function GroupStage({
  shot,
  group,
  assets,
  projectId,
  disabled,
  saving,
  recovering = false,
  error,
  origin,
  update,
  detach,
  onClose,
  history,
  unavailableNotice,
  onAdoptGeneration,
  onOpenArkSettings,
  adopting = false,
  pendingAdoptionJobId = null,
}: {
  shot: ShotWorkspace;
  group: GenerationGroup;
  assets: Asset[];
  projectId: string;
  disabled: boolean;
  saving: boolean;
  recovering?: boolean;
  error: string | null;
  origin: () => { x: number; y: number; width: number; height: number };
  update: ShotUpdate;
  history?: ShotHistoryActions | undefined;
  detach: (id: string, at?: { x: number; y: number }) => void;
  onClose: () => void;
  unavailableNotice?: ReactNode;
  onAdoptGeneration?: ((jobId: string) => Promise<void>) | undefined;
  onOpenArkSettings?: (() => void) | undefined;
  adopting?: boolean;
  pendingAdoptionJobId?: string | null;
}) {
  const generation = useArkGeneration({
    target: { projectId, shotId: shot.id, groupId: group.id },
    sourceVersion: JSON.stringify({
      group,
      nodes: shot.nodes.filter((node) => node.groupId === group.id),
    }),
    disabled,
    pendingAdoptionJobId,
    onAdopt: onAdoptGeneration,
  });
  const generationActions = (
    <ArkGenerationControls
      state={generation}
      kind={group.kind === 'image' ? 'image' : 'video'}
      disabled={disabled}
      pendingAdoptionJobId={pendingAdoptionJobId}
      canAdopt={!!onAdoptGeneration}
      onOpenSettings={onOpenArkSettings}
    />
  );
  const dialog = useRef<HTMLDialogElement>(null);
  const closeMotion = useGroupStageMotion(dialog, origin, onClose);
  const requestClose = () => {
    if (recovering || adopting || generation.busy?.startsWith('adopt:')) return;
    // Local name inputs must join the retained draft before their editor unmounts.
    void flushPendingChanges().then((saved) => {
      if (saved) closeMotion();
    });
  };
  const placeholderId = useRef(crypto.randomUUID());
  const checkedPlaceholder = useRef(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const members = shot.nodes.filter((node) => node.groupId === group.id);
  const textNodes = members.filter(
    (node) =>
      node.type === 'text' ||
      assets.some(
        (asset) =>
          node.type === 'asset' &&
          asset.id === node.assetId &&
          asset.kind === 'text',
      ),
  );
  const textIds = new Set(textNodes.map((node) => node.id));
  const media = members.filter((node) => !textIds.has(node.id));
  useLayoutEffect(() => {
    if (disabled || checkedPlaceholder.current) return;
    checkedPlaceholder.current = true;
    if (textNodes.length || members.length >= 32) return;
    // A strict-mode replay uses the same ID; append is idempotent.
    if (shot.nodes.some((node) => node.id === placeholderId.current))
      placeholderId.current = crypto.randomUUID();
    const id = placeholderId.current;
    update((current) => appendGroupText(current, group.id, id), {
      record: false,
    });
  }, [
    disabled,
    textNodes.length,
    members.length,
    shot.nodes,
    group.id,
    update,
  ]);
  const add = (text = '') => {
    if (disabled || members.length >= 32) return;
    const id = crypto.randomUUID();
    update((current) => appendGroupText(current, group.id, id, text));
    setFocusId(id);
  };
  return (
    <dialog
      ref={dialog}
      closedby="none"
      className="group-stage"
      aria-label={
        group.kind === 'image' ? '图片生成组合编辑' : '视频生成组合编辑'
      }
      onKeyDown={(event) => {
        if (
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        requestClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
    >
      <header className="group-stage-toolbar">
        <Button
          variant="outline"
          className="rounded-full bg-background/90 shadow-sm"
          onClick={requestClose}
          disabled={recovering || adopting}
        >
          <ArrowLeft />
          收起组合
        </Button>
        {history && (
          <fieldset
            className="flex gap-1 rounded-full border bg-background/90 px-1 shadow-sm"
            aria-label="组合编辑撤销操作"
          >
            <HistoryActions
              {...history}
              disabled={disabled}
              shortcuts={{ undo: null, redo: null }}
              isMac={isMac}
            />
          </fieldset>
        )}
        <span
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
          role="status"
        >
          {saving ? (
            <LoaderCircle className="size-3 animate-spin" />
          ) : (
            <Check className="size-3" />
          )}
          {disabled
            ? '暂不可编辑'
            : error
              ? '保存失败'
              : saving
                ? '保存中…'
                : '已保存'}
        </span>
      </header>
      <div className="absolute inset-x-8 top-20 z-30 space-y-2">
        <div data-save-status-host className="empty:hidden" />
        {unavailableNotice && (
          <div className="rounded-lg overflow-hidden shadow-sm">
            {unavailableNotice}
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="group-stage-error">
          {error}
        </p>
      )}
      <div className="group-stage-layout">
        <div data-stage-panel className="group-stage-media">
          <MaterialArc
            nodes={media}
            assets={assets}
            projectId={projectId}
            disabled={disabled}
            detach={(id) => detach(id)}
          />
        </div>
        <div data-stage-panel className="group-stage-text">
          <GroupTextStack
            title={group.kind === 'image' ? '图片描述' : '镜头文本'}
            placeholder={
              group.kind === 'image'
                ? '描述主体、场景、风格，或需要修改的内容…'
                : '描述画面、动作、镜头和对白…'
            }
            nodes={textNodes}
            projectId={projectId}
            disabled={disabled}
            full={members.length >= 32}
            focusId={focusId}
            edit={(id, text) => {
              if (!disabled)
                update((current) => editMaterialText(current, id, text), {
                  mergeKey: `text:${id}`,
                });
            }}
            add={add}
            reorder={(ids) => {
              if (!disabled)
                update((current) =>
                  reorderGroupMembers(current, group.id, ids),
                );
            }}
            detach={detach}
            onViewCanvas={requestClose}
          />
        </div>
        <div data-stage-panel className="group-stage-parameters">
          {group.kind === 'image' ? (
            <ImageGenerationSettings
              actions={generationActions}
              disabled={disabled}
              value={group.parameters}
              references={imageReferenceCount(members, assets)}
              onChange={(parameters) =>
                update(
                  (current) => ({
                    ...current,
                    groups: current.groups.map((item) =>
                      item.id === group.id && item.kind === 'image'
                        ? { ...item, parameters }
                        : item,
                    ),
                  }),
                  {
                    mergeKey: parameterMergeKey(
                      group.id,
                      group.parameters,
                      parameters,
                    ),
                  },
                )
              }
            />
          ) : (
            <GenerationSettings
              actions={generationActions}
              disabled={disabled}
              value={group.parameters}
              onChange={(parameters) =>
                update(
                  (current) => ({
                    ...current,
                    groups: current.groups.map((item) =>
                      item.id === group.id && item.kind !== 'image'
                        ? { ...item, parameters }
                        : item,
                    ),
                  }),
                  {
                    mergeKey: parameterMergeKey(
                      group.id,
                      group.parameters,
                      parameters,
                    ),
                  },
                )
              }
            />
          )}
        </div>
      </div>
    </dialog>
  );
}
