import type { Node, NodeProps } from '@xyflow/react';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SnapTarget } from '../../../../shared/canvas/operations';
import type { Asset } from '../../../../shared/models';
import { formatDuration, mediaUrl } from './media';

export type VideoCardNode = Node<
  {
    assets: Asset[];
    projectId: string;
    width: number;
    activeAssetId: string | null;
    snapSide: SnapTarget['side'] | null;
    play: (id: string) => void;
    selectAsset: (cardId: string, assetId: string) => void;
  },
  'video'
>;

function VideoThumbnail({
  asset,
  projectId,
  index,
  active,
  select,
  grouped,
}: {
  asset: Asset;
  projectId: string;
  index: number;
  active: boolean;
  select: () => void;
  grouped: boolean;
}) {
  const [duration, setDuration] = useState<number | null>(null);
  return (
    <button
      type="button"
      aria-label={`选择片段 ${index + 1} ${asset.name}`}
      aria-pressed={active}
      onClick={select}
      className={cn(
        'relative block h-[162px] shrink-0 cursor-grab overflow-hidden bg-slate-900 text-left text-white outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary active:cursor-grabbing',
        grouped ? 'w-[216px]' : 'w-[288px]',
      )}
    >
      <video
        muted
        preload="metadata"
        src={mediaUrl(projectId, asset.id)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        className="pointer-events-none h-full w-full object-cover"
        aria-label={`${asset.name} 缩略预览`}
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-3 bg-linear-to-b from-black/60 to-transparent px-3 pt-2.5 pb-7 text-[11px]">
        <span className="min-w-0 truncate">
          {String(index + 1).padStart(2, '0')} · {asset.name}
        </span>
        <span className="shrink-0 tabular-nums">
          {duration === null ? '' : formatDuration(duration)}
        </span>
      </div>
      {active && grouped && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-primary" />
      )}
    </button>
  );
}

export function VideoCard({
  id,
  data,
  selected,
  dragging,
}: NodeProps<VideoCardNode>) {
  const grouped = data.assets.length > 1;
  return (
    <article
      style={{ width: data.width }}
      className={cn(
        'relative rounded-lg bg-background shadow-sm ring-1 ring-border',
        selected && 'ring-2 ring-primary/60',
        dragging && 'shadow-lg',
      )}
    >
      <div
        className="nowheel nopan flex divide-x divide-white/15 overflow-x-auto rounded-t-[7px]"
        style={{ scrollbarWidth: 'thin' }}
      >
        {data.assets.map((asset, index) => (
          <VideoThumbnail
            key={asset.id}
            asset={asset}
            projectId={data.projectId}
            index={index}
            active={selected === true && data.activeAssetId === asset.id}
            grouped={grouped}
            select={() => data.selectAsset(id, asset.id)}
          />
        ))}
      </div>
      <footer className="flex h-10 items-center gap-3 px-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {grouped ? `组合 · ${data.assets.length} 段` : data.assets[0]?.name}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="nodrag nopan shrink-0"
          aria-label={
            grouped
              ? `播放组合，共 ${data.assets.length} 段`
              : `播放 ${data.assets[0]?.name}`
          }
          onClick={(event) => {
            event.stopPropagation();
            data.play(id);
          }}
        >
          <Play size={14} fill="currentColor" />
          播放
        </Button>
      </footer>
      {data.snapSide && (
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute -top-1 -bottom-1 w-1 rounded-full bg-primary',
            data.snapSide === 'left' ? '-left-2' : '-right-2',
          )}
        />
      )}
    </article>
  );
}
