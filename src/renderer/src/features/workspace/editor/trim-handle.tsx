import type { PointerEventHandler } from 'react';
import { cn } from '@/lib/utils';
import { type ClipTrim, changeTrim } from '../../../../../shared/canvas/trim';
import { formatTime, type TimelineClip } from './timeline';

type Edge = 'start' | 'end';

export function TrimHandle({
  clip,
  edge,
  width,
  disabled,
  dragging,
  onChange,
  onPointerDown,
  onLostPointerCapture,
}: {
  clip: TimelineClip;
  edge: Edge;
  width: number;
  disabled: boolean;
  dragging: boolean;
  onChange: (range: ClipTrim) => void;
  onPointerDown: PointerEventHandler<HTMLButtonElement>;
  onLostPointerCapture: PointerEventHandler<HTMLButtonElement>;
}) {
  // Only the grip is painted, inside the clip. Invisible hit slop keeps very
  // short clips draggable; each target stops at the midpoint, never overlapping.
  const slop = 8;
  const inset = Math.min(8, width / 4);
  return (
    <button
      type="button"
      role="slider"
      aria-label={edge === 'start' ? '片段起点' : '片段终点'}
      aria-valuemin={
        edge === 'start' ? 0 : clip.range.start + Math.min(0.1, clip.duration)
      }
      aria-valuemax={
        edge === 'end'
          ? clip.duration
          : clip.range.end - Math.min(0.1, clip.duration)
      }
      aria-valuenow={clip.range[edge]}
      aria-valuetext={formatTime(clip.range[edge])}
      disabled={disabled}
      className={cn(
        'group/trim absolute inset-y-0 flex touch-none items-center bg-transparent outline-none transition-opacity duration-150 ease-out focus-visible:transition-none disabled:cursor-not-allowed motion-reduce:transition-none',
        dragging
          ? 'pointer-events-auto opacity-100'
          : 'pointer-events-none opacity-0 group-hover/clip:pointer-events-auto group-hover/clip:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100',
        edge === 'start' ? 'cursor-w-resize' : 'cursor-e-resize',
      )}
      style={{
        width: Math.min(24, width / 2 + slop),
        [edge === 'start' ? 'left' : 'right']: -slop,
      }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        event.stopPropagation();
        onChange(
          changeTrim(
            clip.range,
            edge,
            clip.range[edge] +
              (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 0.1),
            clip.duration,
          ),
        );
      }}
      onPointerDown={onPointerDown}
      onLostPointerCapture={onLostPointerCapture}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute h-6 rounded-full bg-white/90 shadow-[0_1px_4px_#0006] group-hover/trim:bg-white group-focus-visible/trim:ring-2 group-focus-visible/trim:ring-primary"
        style={{
          width: Math.min(3, width / 2),
          [edge === 'start' ? 'left' : 'right']: slop + inset,
          transform: `translateX(${edge === 'start' ? '-50%' : '50%'})`,
        }}
      />
    </button>
  );
}
