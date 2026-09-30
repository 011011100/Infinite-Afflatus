import type { Node, NodeProps } from '@xyflow/react';
import { SlidersHorizontal, Sparkles, Ungroup, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { GenerationParameters } from '../../../../shared/generation/draft';
import type { GenerationGroup } from '../../../../shared/generation/workspace';
import { GenerationSettings } from './generation-parameters';

export type GenerationGroupNode = Node<
  {
    group: GenerationGroup;
    count: number;
    open: boolean;
    blocked: boolean;
    toggle: (id: string | null) => void;
    ungroup: (id: string) => void;
    change: (id: string, parameters: GenerationParameters) => void;
  },
  'generationGroup'
>;
export function GenerationGroupCard({
  id,
  data,
  selected,
}: NodeProps<GenerationGroupNode>) {
  return (
    <div
      data-generation-group-frame
      className={cn(
        'h-full rounded-2xl border-2 border-primary/60 bg-primary/5 shadow-sm',
        selected && 'border-primary',
      )}
    >
      <header className="material-handle flex h-10 items-center gap-2 px-4 text-xs text-primary">
        <Sparkles className="size-4" />
        <span className="font-medium">视频生成</span>
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
            onClick={() => data.toggle(data.open ? null : id)}
          >
            <SlidersHorizontal />
            参数
          </Button>
        </div>
      </header>
      {data.open && (
        <div className="nodrag nopan nowheel generation-group-settings absolute left-full top-0 ml-5 w-[276px]">
          <Button
            className="absolute right-3 top-3 z-10"
            variant="ghost"
            size="icon-xs"
            aria-label="收起生成参数"
            onClick={() => data.toggle(null)}
          >
            <X />
          </Button>
          <fieldset disabled={data.blocked}>
            <GenerationSettings
              value={data.group.parameters}
              onChange={(parameters) => data.change(id, parameters)}
            />
          </fieldset>
        </div>
      )}
    </div>
  );
}
