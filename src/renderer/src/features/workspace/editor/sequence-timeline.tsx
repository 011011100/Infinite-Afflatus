import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { type ClipTrim, changeTrim } from '../../../../../shared/canvas/trim';
import type { ThumbnailFrame } from '../decode-thumbnail';
import { Filmstrip } from './filmstrip';
import {
  formatTime,
  rulerStep,
  type TimelineClip,
  totalDuration,
} from './timeline';

type Edge = 'start' | 'end';
interface TrimGesture {
  pointer: number;
  x: number;
  scale: number;
  index: number;
  edge: Edge;
  clips: TimelineClip[];
  value: ClipTrim;
}

export function SequenceTimeline({
  clips,
  frames,
  time,
  playingIndex,
  selected,
  disabled,
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
  onSelect: (index: number) => void;
  onSeek: (time: number) => void;
  onPreview: (index: number, range: ClipTrim, edge: Edge) => void;
  onCommit: (index: number, range: ClipTrim) => void;
  onCancel: () => void;
  onGesture: (active: boolean) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const gesture = useRef<TrimGesture | null>(null);
  const [dragging, setDragging] = useState(false);
  const [width, setWidth] = useState(900);
  const [zoom, setZoom] = useState(1);
  const total = totalDuration(clips);
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setWidth(element.clientWidth - 64),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale =
    gesture.current?.scale ?? Math.max(8, Math.min(100, width / total)) * zoom;
  const layout = gesture.current?.clips ?? clips;
  const step = rulerStep(scale);
  const visualTotal = Math.max(total, totalDuration(layout));
  const ticks = Array.from(
    { length: Math.floor(visualTotal / step) + 1 },
    (_, index) => index * step,
  );
  const finish = (cancel: boolean) => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    setDragging(false);
    onGesture(false);
    if (cancel) onCancel();
    else onCommit(current.index, current.value);
  };
  // Escape and lost window focus cancel the draft instead of committing it.
  useLayoutEffect(() => {
    if (!dragging) return;
    const cancel = () => finish(true);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
    };
  });
  const seekAt = (x: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (rect) onSeek(Math.max(0, Math.min(total, (x - rect.left) / scale)));
  };
  return (
    <section
      className="shrink-0 border-t border-border bg-background pb-5"
      aria-label="组合时间轨道"
    >
      <div className="flex h-11 items-center justify-between gap-3 px-8 text-xs text-muted-foreground">
        <span>
          {clips.length} 个片段 <span className="mx-2 text-border">/</span>{' '}
          {formatTime(total)}
        </span>
        <label className="flex items-center gap-2">
          轨道缩放
          <input
            aria-label="轨道缩放"
            type="range"
            min="0.5"
            max="6"
            step="0.1"
            value={zoom}
            disabled={dragging}
            onChange={(event) => setZoom(Number(event.target.value))}
            className="w-24 accent-primary"
          />
        </label>
      </div>
      <div
        ref={scroll}
        className="overflow-x-auto overscroll-x-contain px-8 pb-4"
      >
        <div
          ref={track}
          className="relative h-32 touch-none select-none"
          style={{ width: Math.max(width, visualTotal * scale) }}
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
            {ticks.map((tick) => (
              <span
                key={tick}
                className="pointer-events-none absolute bottom-0 h-6 border-l border-border text-[10px] tabular-nums text-muted-foreground"
                style={{ left: tick * scale }}
              >
                <span className="relative -top-1 ml-1.5">
                  {tick < 60 ? `${tick}s` : formatTime(tick)}
                </span>
              </span>
            ))}
          </div>
          {clips.map((clip, index) => {
            const base = layout[index] ?? clip;
            const left =
              (base.offset +
                (dragging && selected === index
                  ? clip.range.start - base.range.start
                  : 0)) *
              scale;
            return (
              <div
                key={clip.asset.id}
                data-timeline-clip={clip.asset.id}
                className={cn(
                  'absolute top-10 h-16 rounded-md',
                  !dragging &&
                    'transition-[left,width] duration-150 motion-reduce:transition-none',
                  selected === index
                    ? 'z-10 ring-2 ring-primary'
                    : 'ring-1 ring-border',
                )}
                style={{ left, width: Math.max(2, clip.length * scale - 2) }}
              >
                <button
                  type="button"
                  aria-label={`选择片段 ${index + 1} ${clip.asset.name}`}
                  aria-pressed={selected === index}
                  className="relative size-full overflow-hidden rounded-md bg-muted text-left outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={(event) => {
                    onSelect(index);
                    seekAt(event.clientX);
                  }}
                >
                  <Filmstrip frame={frames.get(clip.asset.id)} />
                  <div className="absolute inset-0 bg-linear-to-t from-black/80 via-black/10 to-black/10" />
                  <span className="absolute inset-x-3 bottom-2 truncate text-[11px] text-white">
                    {String(index + 1).padStart(2, '0')} · {clip.asset.name}
                  </span>
                  {playingIndex === index && (
                    <span
                      role="img"
                      aria-label="当前播放片段"
                      className="absolute inset-x-0 top-0 h-1 bg-primary"
                    />
                  )}
                </button>
                {selected === index &&
                  (['start', 'end'] as const).map((edge) => (
                    <button
                      key={edge}
                      type="button"
                      role="slider"
                      aria-label={edge === 'start' ? '片段起点' : '片段终点'}
                      aria-valuemin={
                        edge === 'start'
                          ? 0
                          : clip.range.start + Math.min(0.1, clip.duration)
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
                        'absolute top-0 flex h-full w-3 touch-none items-center justify-center bg-primary text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-primary disabled:cursor-not-allowed',
                        edge === 'start'
                          ? '-left-1 rounded-l-md cursor-w-resize'
                          : '-right-1 rounded-r-md cursor-e-resize',
                      )}
                      onKeyDown={(event) => {
                        if (
                          event.key !== 'ArrowLeft' &&
                          event.key !== 'ArrowRight'
                        )
                          return;
                        event.preventDefault();
                        event.stopPropagation();
                        const range = changeTrim(
                          clip.range,
                          edge,
                          clip.range[edge] +
                            (event.key === 'ArrowLeft' ? -1 : 1) *
                              (event.shiftKey ? 1 : 0.1),
                          clip.duration,
                        );
                        onPreview(index, range, edge);
                        onCommit(index, range);
                      }}
                      onPointerDown={(event) => {
                        if (disabled || event.button !== 0) return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        gesture.current = {
                          pointer: event.pointerId,
                          x: event.clientX,
                          scale,
                          index,
                          edge,
                          clips,
                          value: clip.range,
                        };
                        setDragging(true);
                        onGesture(true);
                      }}
                      onPointerMove={(event) => {
                        const current = gesture.current;
                        if (!current || current.pointer !== event.pointerId)
                          return;
                        const original = current.clips[index];
                        if (!original) return;
                        current.value = changeTrim(
                          original.range,
                          edge,
                          original.range[edge] +
                            (event.clientX - current.x) / current.scale,
                          clip.duration,
                        );
                        onPreview(index, current.value, edge);
                      }}
                      onPointerUp={() => finish(false)}
                      onPointerCancel={() => finish(true)}
                      onLostPointerCapture={() => finish(true)}
                    >
                      <span className="h-5 w-0.5 rounded-full bg-current/90" />
                    </button>
                  ))}
              </div>
            );
          })}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 z-20 h-[116px] w-px bg-primary"
            style={{ left: Math.min(time, total) * scale }}
          >
            <span className="absolute -left-[4px] top-0 size-[9px] rounded-b-sm bg-primary" />
          </div>
        </div>
      </div>
    </section>
  );
}
