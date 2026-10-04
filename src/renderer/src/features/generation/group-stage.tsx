import { ArrowLeft, Check, LoaderCircle } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  appendGroupText,
  editMaterialText,
  reorderGroupMembers,
} from '../../../../shared/generation/group-editing';
import { imageReferenceCount } from '../../../../shared/generation/image-generation';
import type {
  GenerationGroup,
  ShotWorkspace,
} from '../../../../shared/generation/workspace';
import type { Asset } from '../../../../shared/models';
import { GenerationSettings } from './generation-parameters';
import { GroupTextStack } from './group-text-stack';
import { ImageGenerationSettings } from './image-generation-parameters';
import { MaterialArc } from './material-arc';
import { useGroupStageMotion } from './use-group-stage-motion';
import './group-stage.css';

export function GroupStage({
  shot,
  group,
  assets,
  projectId,
  disabled,
  saving,
  error,
  origin,
  update,
  detach,
  onClose,
}: {
  shot: ShotWorkspace;
  group: GenerationGroup;
  assets: Asset[];
  projectId: string;
  disabled: boolean;
  saving: boolean;
  error: string | null;
  origin: () => { x: number; y: number; width: number; height: number };
  update: (change: (shot: ShotWorkspace) => ShotWorkspace) => void;
  detach: (id: string, at?: { x: number; y: number }) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const requestClose = useGroupStageMotion(dialog, origin, onClose);
  const placeholderId = useRef(crypto.randomUUID());
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
    if (disabled || textNodes.length || members.length >= 32) return;
    // A strict-mode replay uses the same ID; append is idempotent.
    if (shot.nodes.some((node) => node.id === placeholderId.current))
      placeholderId.current = crypto.randomUUID();
    const id = placeholderId.current;
    update((current) => appendGroupText(current, group.id, id));
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
      className="group-stage"
      aria-label={
        group.kind === 'image' ? '图片生成组合编辑' : '视频生成组合编辑'
      }
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
        >
          <ArrowLeft />
          收起组合
        </Button>
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
                update((current) => editMaterialText(current, id, text));
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
        <fieldset
          data-stage-panel
          className="group-stage-parameters"
          disabled={disabled}
        >
          {group.kind === 'image' ? (
            <ImageGenerationSettings
              value={group.parameters}
              references={imageReferenceCount(members, assets)}
              onChange={(parameters) =>
                update((current) => ({
                  ...current,
                  groups: current.groups.map((item) =>
                    item.id === group.id && item.kind === 'image'
                      ? { ...item, parameters }
                      : item,
                  ),
                }))
              }
            />
          ) : (
            <GenerationSettings
              value={group.parameters}
              onChange={(parameters) =>
                update((current) => ({
                  ...current,
                  groups: current.groups.map((item) =>
                    item.id === group.id && item.kind !== 'image'
                      ? { ...item, parameters }
                      : item,
                  ),
                }))
              }
            />
          )}
        </fieldset>
      </div>
    </dialog>
  );
}
