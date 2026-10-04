import type { Node, NodeProps } from '@xyflow/react';
import { ArrowUpRight, Clapperboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
export type ShotCardNode = Node<
  { name: string; count: number; disabled: boolean; open: () => void },
  'shot'
>;
export function ShotCard({ data, selected }: NodeProps<ShotCardNode>) {
  return (
    <article
      className={cn(
        'w-72 overflow-hidden rounded-lg border bg-card shadow-sm',
        selected && 'ring-2 ring-primary/60',
      )}
    >
      <div className="flex h-[162px] flex-col items-center justify-center gap-3 bg-muted/50">
        <Clapperboard className="size-8 text-primary/60" />
        <span className="text-sm font-medium">{data.name}</span>
        <span className="text-xs text-muted-foreground">
          待生成镜头{data.count ? ` · ${data.count} 个素材` : ''}
        </span>
      </div>
      <footer className="flex h-10 items-center justify-end px-3">
        <Button
          variant="ghost"
          size="sm"
          className="nodrag nopan"
          disabled={data.disabled}
          onClick={data.open}
        >
          素材画布
          <ArrowUpRight />
        </Button>
      </footer>
    </article>
  );
}
