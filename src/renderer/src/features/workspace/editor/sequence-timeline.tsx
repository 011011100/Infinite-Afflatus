import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { ClipTrim } from '../../../../../shared/canvas/trim';
import type { ThumbnailFrame } from '../decode-thumbnail';
import { Filmstrip } from './filmstrip';
import {
  formatTime,
  type TimelineClip,
  timelineOrigin,
  totalDuration,
} from './timeline';
import { TimelineRuler } from './timeline-ruler';
import { TrimHandle } from './trim-handle';
import { useTrimGesture } from './use-trim-gesture';

type Edge = 'start' | 'end';

export function SequenceTimeline({
  clips,
  frames,
  time,
  playingIndex,
  selected,
  disabled,
  reset,
  zoom,
  onSelect,
  onSeek,
  onPreview,
  onCommit,
  onCancel,
  onGesture,
}: {
  clips: TimelineClip[];
  frames: Map<string, ThumbnailFrame>;
  time: number;
  playingIndex: number;
  selected: number;
  disabled: boolean;
  reset: number;
  zoom: number;
  onSelect: (index: number) => void;
  onSeek: (time: number) => void;
  onPreview: (index: number, range: ClipTrim, edge: Edge) => void;
  onCommit: (index: number, range: ClipTrim) => void;
  onCancel: () => void;
  onGesture: (active: boolean) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const initial = useRef({
    duration: totalDuration(clips),
    origin: timelineOrigin(clips),
  });
  const [width, setWidth] = useState(900);
  const total = totalDuration(clips);
  const origin = timelineOrigin(clips);
  // Shrinking scrollWidth at the right edge clamps scrollLeft. That movement
  // would feed back into the captured drag delta and make the handle run away.
  // Keep the session's furthest extent, including after release/save.
  const extent = useRef(origin + total);
  extent.current = Math.max(extent.current, origin + total);
  const scale =
    Math.max(8, Math.min(100, width / initial.current.duration)) * zoom;
  const trackWidth = Math.max(
    width,
    extent.current * scale,
    initial.current.origin * scale + width,
  );
  const gesture = useTrimGesture({
    clips,
    scale,
    disabled,
    reset,
    scrollLeft: () => scroll.current?.scrollLeft ?? 0,
    preview: onPreview,
    commit: onCommit,
    cancel: onCancel,
    active: onGesture,
  });
  const { dragging } = gesture;
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    let initialized = false;
    const observer = new ResizeObserver(() => {
      const width = element.clientWidth - 64;
      setWidth(width);
      if (!initialized) {
        element.scrollLeft =
          initial.current.origin *
          Math.max(8, Math.min(100, width / initial.current.duration));
        initialized = true;
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const seekAt = (x: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (rect)
      onSeek(Math.max(0, Math.min(total, (x - rect.left) / scale - origin)));
  };
  return (
    <section className="shrink-0 bg-background pb-5" aria-label="组合时间轨道">
      <div
        ref={scroll}
        className="overflow-x-auto overscroll-x-contain px-8 pb-4 [overflow-anchor:none]"
      >
        <div
          ref={track}
          className="relative h-32 touch-none select-none"
          style={{ width: trackWidth }}
        >
          <div
            role="slider"
            tabIndex={0}
            aria-label="播放位置"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={Math.min(time, total)}
            aria-valuetext={formatTime(time)}
            className="absolute inset-x-0 top-0 h-8 cursor-col-resize outline-none focus-visible:ring-2 focus-visible:ring-primary"
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                onSeek(
                  Math.max(
                    0,
                    Math.min(
                      total,
                      time + (event.key === 'ArrowLeft' ? -0.1 : 0.1),
                    ),
                  ),
                );
              }
              if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                onSeek(event.key === 'Home' ? 0 : total);
              }
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              seekAt(event.clientX);
            }}
            onPointerMove={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                seekAt(event.clientX);
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                seekAt(event.clientX);
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
            }}
          >
            <TimelineRuler
              duration={Math.max(total, trackWidth / scale - origin)}
              origin={origin}
              scale={scale}
            />
          </div>
          {clips.map((clip, index) => {
            const left = (origin + clip.offset) * scale;
            const clipWidth = Math.max(2, clip.length * scale - 2);
            return (
              <div
                key={clip.asset.id}
                data-timeline-clip={clip.asset.id}
                className={cn(
                  'group/clip absolute top-10 h-16 rounded-md hover:z-20 focus-within:z-20',
                  selected === index && 'z-10',
                  gesture.draggingIndex === index && 'z-30',
                )}
                style={{ left, width: clipWidth }}
              >
                <button
                  type="button"
                  aria-label={`选择片段 ${index + 1} ${clip.asset.name}`}
                  aria-pressed={selected === index}
                  className="group/clip-surface relative block size-full overflow-hidden rounded-[inherit] bg-muted text-left outline-none"
                  onClick={(event) => {
                    onSelect(index);
                    seekAt(event.clientX);
                  }}
                >
                  <Filmstrip
                    frame={frames.get(clip.asset.id)}
                    sourceOffset={clip.range.start * scale}
                  />
                  {playingIndex === index && (
                    <span
                      role="img"
                      aria-label="当前播放片段"
                      className="absolute inset-x-0 top-0 h-1 bg-primary"
                    />
                  )}
                  {/* Paint the frame inside the same rounded surface as the
                      filmstrip, so separate outer rings cannot leave a seam. */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      'pointer-events-none absolute inset-0 rounded-[inherit] group-focus-visible/clip-surface:border-2 group-focus-visible/clip-surface:border-primary',
                      selected === index
                        ? 'border-2 border-primary'
                        : 'border border-foreground/10',
                    )}
                  />
                </button>
                {(['start', 'end'] as const).map((edge) => (
                  <TrimHandle
                    key={edge}
                    clip={clip}
                    edge={edge}
                    width={clipWidth}
                    disabled={disabled}
                    dragging={gesture.draggingIndex === index}
                    pressure={
                      gesture.boundary?.index === index &&
                      gesture.boundary.edge === edge
                        ? gesture.boundary.pressure
                        : 0
                    }
                    onChange={(range) => {
                      onSelect(index);
                      onPreview(index, range, edge);
                      onCommit(index, range);
                    }}
                    onPointerDown={(event) => {
                      if (disabled || event.button !== 0 || dragging) return;
                      onSelect(index);
                      gesture.start(event, index, edge);
                    }}
                    onLostPointerCapture={gesture.lostCapture}
                  />
                ))}
              </div>
            );
          })}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 z-20 h-[116px] w-px bg-primary"
            style={{ left: (origin + Math.min(time, total)) * scale }}
          >
            <span className="absolute -left-[4px] top-0 size-[9px] rounded-b-sm bg-primary" />
          </div>
        </div>
      </div>
    </section>
  );
}
