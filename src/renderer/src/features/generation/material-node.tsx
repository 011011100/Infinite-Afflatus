import type { Node, NodeProps } from '@xyflow/react';
import { Type, X } from 'lucide-react';
import { useLongPressSplit } from '@/components/canvas/use-long-press-split';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { MaterialNode } from '../../../../shared/generation/workspace';
import type { Asset } from '../../../../shared/models';
import { ReferenceCard, referenceLabels } from './reference-card';

export type MaterialFlowNode = Node<
  {
    material: MaterialNode;
    asset: Asset | undefined;
    projectId: string;
    blocked: boolean;
    longPressSplit: boolean;
    select: (id: string) => void;
    detach: (id: string) => void;
    text: (id: string, value: string) => void;
    remove: (id: string) => void;
  },
  'material'
>;

export function MaterialCard({
  id,
  data,
  selected,
}: NodeProps<MaterialFlowNode>) {
  const material = data.material;
  const hold = useLongPressSplit(
    !!material.groupId && data.longPressSplit && !data.blocked,
    () => data.select(id),
    () => data.detach(id),
  );
  return (
    <div
      onPointerDownCapture={(event) => {
        if (
          !material.groupId ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.shiftKey
        )
          return;
        // Text editing, media controls, and buttons must never start a detach gesture.
        if (
          (event.target as Element).closest(
            'button, input, textarea, select, a, video, audio, [contenteditable="true"]',
          )
        )
          return;
        hold.onPointerDown(event);
      }}
      onClickCapture={(event) => {
        if (hold.consumeClick()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onDoubleClickCapture={hold.cancel}
      onContextMenuCapture={hold.cancel}
      className={cn(
        'material-card h-full rounded-xl bg-card shadow-sm ring-1 ring-border transition-shadow',
        selected && 'ring-2 ring-primary',
      )}
    >
      {material.type === 'text' ? (
        <>
          <header className="material-handle flex h-10 items-center gap-2 px-3 text-xs font-medium">
            <Type className="size-3.5 text-muted-foreground" />
            文本
            <Button
              className="nodrag nopan ml-auto"
              variant="ghost"
              size="icon-xs"
              aria-label="移除文本卡片"
              disabled={data.blocked}
              onClick={() => data.remove(id)}
            >
              <X />
            </Button>
          </header>
          <Textarea
            aria-label="文本卡片内容"
            placeholder="写下这个镜头的画面、动作与对白…"
            value={material.text}
            maxLength={10000}
            disabled={data.blocked}
            onChange={(event) => data.text(id, event.target.value)}
            className="nodrag nopan nowheel h-[204px] min-h-0 rounded-t-none border-0 bg-transparent p-4 text-sm leading-6 focus:ring-0"
          />
        </>
      ) : data.asset ? (
        <ReferenceCard
          projectId={data.projectId}
          asset={data.asset}
          textOverride={material.textOverride}
          label={referenceLabels[data.asset.kind]}
          onRemove={() => data.remove(id)}
          disabled={data.blocked}
        />
      ) : (
        <div className="material-handle flex h-full flex-col items-center justify-center gap-3 p-5 text-xs text-muted-foreground">
          素材正在保存或暂不可用
          <Button
            className="nodrag nopan"
            size="xs"
            variant="ghost"
            disabled={data.blocked}
            onClick={() => data.remove(id)}
          >
            移除引用
          </Button>
        </div>
      )}
    </div>
  );
}
