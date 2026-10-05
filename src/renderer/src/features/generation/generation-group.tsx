import type { Node, NodeProps } from '@xyflow/react';
import { Expand, Image, Sparkles, Ungroup } from 'lucide-react';
import { stopCanvasControlKeys } from '@/components/canvas/keyboard-boundary';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { GenerationGroup } from '../../../../shared/generation/workspace';

export type GenerationGroupNode = Node<
  {
    group: GenerationGroup;
    count: number;
    open: boolean;
    blocked: boolean;
    receiving?: boolean;
    toggle: (id: string | null) => void;
    ungroup: (id: string) => void;
  },
  'generationGroup'
>;
export function GenerationGroupCard({
  id,
  data,
  selected,
}: NodeProps<GenerationGroupNode>) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Only a bubbling boundary for nested controls; React Flow owns node keyboard interaction.
    <div
      onKeyDown={stopCanvasControlKeys}
      data-generation-group-frame
      data-generation-kind={data.group.kind ?? 'video'}
      data-receiving={data.receiving || undefined}
      className={cn(
        'h-full rounded-2xl border-2 border-primary/60 bg-primary/5 shadow-sm',
        selected && 'border-primary',
        data.receiving && 'border-primary ring-2 ring-primary/20',
      )}
    >
      <header className="material-handle flex h-10 items-center gap-2 px-4 text-xs text-primary">
        {data.group.kind === 'image' ? (
          <Image className="size-4" />
        ) : (
          <Sparkles className="size-4" />
        )}
        <span className="font-medium">
          {data.group.kind === 'image' ? '图片生成' : '视频生成'}
        </span>
        <span className="text-muted-foreground">{data.count} 个素材</span>
        <div className="nodrag nopan ml-auto flex gap-1">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="解除生成组"
            disabled={data.blocked}
            onClick={() => data.ungroup(id)}
          >
            <Ungroup />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={data.open}
            onClick={() => data.toggle(id)}
          >
            <Expand />
            展开编辑
          </Button>
        </div>
      </header>
    </div>
  );
}
