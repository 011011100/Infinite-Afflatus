import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { Asset } from '../../../../shared/models';
import { HoldSplitIndicator } from './hold-split-indicator';
import { formatDuration, mediaUrl } from './media';
import { useLongPressSplit } from './use-long-press-split';

export function VideoThumbnail({
  asset,
  projectId,
  index,
  active,
  select,
  grouped,
  canHold,
  split,
}: {
  asset: Asset;
  projectId: string;
  index: number;
  active: boolean;
  select: () => void;
  grouped: boolean;
  canHold: boolean;
  split: () => void;
}) {
  const [duration, setDuration] = useState<number | null>(null);
  const hold = useLongPressSplit(grouped && canHold, select, split);
  return (
    <button
      type="button"
      aria-label={`选择片段 ${index + 1} ${asset.name}`}
      aria-pressed={active}
      data-video-thumbnail
      onPointerDown={hold.onPointerDown}
      onDoubleClick={hold.cancel}
      onContextMenu={hold.cancel}
      onClick={(event) => {
        if (hold.consumeClick()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        select();
      }}
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
      {hold.phase !== 'idle' && (
        <HoldSplitIndicator ready={hold.phase === 'ready'} />
      )}
      {active && grouped && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-primary" />
      )}
    </button>
  );
}
