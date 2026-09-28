import { VideoOff } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { type ClipTrim, clipRange } from '../../../../shared/canvas/trim';
import type { Asset } from '../../../../shared/models';
import { formatDuration } from './media';
import { useThumbnail } from './thumbnail-provider';
import { useLongPressSplit } from './use-long-press-split';

export function VideoThumbnail({
  asset,
  trim,
  projectId,
  index,
  active,
  select,
  grouped,
  canHold,
  split,
}: {
  asset: Asset;
  trim: ClipTrim | undefined;
  projectId: string;
  index: number;
  active: boolean;
  select: () => void;
  grouped: boolean;
  canHold: boolean;
  split: () => void;
}) {
  const { frame, failed } = useThumbnail(projectId, asset);
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const target = canvas.current;
    if (!target || !frame) return;
    target.width = frame.image.width;
    target.height = frame.image.height;
    // Paint before the first frame of a new card; no decoder/loading flash.
    target.getContext('2d')?.drawImage(frame.image, 0, 0);
  }, [frame]);
  const hold = useLongPressSplit(grouped && canHold, select, split);
  return (
    <button
      type="button"
      aria-label={`选择片段 ${index + 1} ${asset.name}`}
      aria-pressed={active}
      data-video-thumbnail
      data-asset-id={asset.id}
      data-flip-id={asset.id}
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
      <canvas
        ref={canvas}
        className="pointer-events-none h-full w-full object-cover"
        role="img"
        aria-label={`${asset.name} 缩略预览`}
      />
      {failed && (
        <span
          className="pointer-events-none absolute inset-0 grid place-items-center"
          title="缩略图读取失败"
        >
          <VideoOff size={24} aria-label="缩略图读取失败" />
        </span>
      )}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-3 bg-linear-to-b from-black/60 to-transparent px-3 pt-2.5 pb-7 text-[11px]">
        <span className="min-w-0 truncate">
          {String(index + 1).padStart(2, '0')} · {asset.name}
        </span>
        <span className="shrink-0 tabular-nums">
          {frame?.duration == null
            ? ''
            : formatDuration(
                trim
                  ? clipRange(frame.duration, trim).end -
                      clipRange(frame.duration, trim).start
                  : frame.duration,
              )}
        </span>
      </div>
      {active && grouped && (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-primary" />
      )}
    </button>
  );
}
