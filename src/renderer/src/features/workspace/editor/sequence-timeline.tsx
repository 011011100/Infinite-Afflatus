// Gesture capture and viewport coordinates must reset together during development updates.
// @refresh reset
import { type KeyboardEvent, useLayoutEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import type { ClipTrim } from '../../../../../shared/canvas/trim';
import { projectEditRecoveryGuards } from '../../drafts/project-edit-recovery-guards';
import type { ThumbnailFrame } from '../decode-thumbnail';
import { mediaUrl } from '../media';
import { mediaRevision, useMediaRevision } from '../use-media-revision';
import { Filmstrip } from './filmstrip';
import {
  formatTime,
  type TimelineClip,
  timelineOrigin,
  totalDuration,
} from './timeline';
import { TimelineRuler } from './timeline-ruler';
import { TrimHandle } from './trim-handle';
import { useFilmstripCache } from './use-filmstrip-cache';
import { useRulerSeek } from './use-ruler-seek';
import { useTimelineViewport } from './use-timeline-viewport';
import { useTrimGesture } from './use-trim-gesture';

type Edge = 'start' | 'end';

export function SequenceTimeline({
  projectId,
  clips,
  frames,
  time,
  playingIndex,
  playing = false,
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
  projectId: string;
  clips: TimelineClip[];
  frames: Map<string, ThumbnailFrame>;
  time: number;
  playingIndex: number;
  playing?: boolean;
  selected: number;
  disabled: boolean;
  reset: number;
  zoom: number;
  onSelect: (index: number) => void;
  onSeek: (time: number, final?: boolean) => void;
  onPreview: (index: number, range: ClipTrim, edge: Edge) => void;
  onCommit: (index: number, range: ClipTrim) => void;
  onCancel: () => void;
  onGesture: (active: boolean) => void;
}) {
  useMediaRevision(projectId);
  const track = useRef<HTMLDivElement>(null);
  const filmstripCache = useFilmstripCache();
  const total = totalDuration(clips);
  const viewport = useTimelineViewport(total, timelineOrigin(clips), zoom);
  const { scroll, origin, scale, trackWidth } = viewport;
  const gesture = useTrimGesture({
    clips,
    scale,
    disabled,
    reset,
    scrollLeft: viewport.position,
    bounds: viewport.bounds,
    panBy: viewport.panBy,
    preview: onPreview,
    commit: onCommit,
    cancel: onCancel,
    active: (active, reserve, cancelled) => {
      viewport.hold(active, reserve, cancelled);
      onGesture(active);
    },
  });
  const { dragging } = gesture;
  const seekAt = (x: number, final = true) => {
    const rect = track.current?.getBoundingClientRect();
    if (rect)
      onSeek(
        Math.max(0, Math.min(total, (x - rect.left) / scale - origin)),
        final,
      );
  };
  const rulerSeek = useRulerSeek(seekAt);
  const headSeek = useRulerSeek(
    seekAt,
    () =>
      (track.current?.getBoundingClientRect().left ?? 0) +
      (origin + Math.max(0, Math.min(time, total))) * scale,
  );
  useLayoutEffect(() => {
    if (playing && !dragging) viewport.reveal(time);
  });
  const seekKey = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
      next = Math.max(
        0,
        Math.min(total, time + (event.key === 'ArrowLeft' ? -0.1 : 0.1)),
      );
    else if (event.key === 'Home' || event.key === 'End')
      next = event.key === 'Home' ? 0 : total;
    else return;
    event.preventDefault();
    onSeek(next);
    viewport.reveal(next);
  };
  return (
    <section className="shrink-0 bg-background pb-5" aria-label="组合时间轨道">
      <div
        ref={scroll}
        className="overflow-x-auto overscroll-x-contain px-8 pb-4 [overflow-anchor:none]"
        onScroll={viewport.constrainScroll}
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
            onKeyDown={seekKey}
            {...rulerSeek}
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
            const frame = frames.get(clip.asset.id)?.image;
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
                    cache={filmstripCache}
                    source={mediaUrl(
                      projectId,
                      clip.asset.id,
                      mediaRevision(projectId, clip.asset.id),
                    )}
                    start={clip.range.start}
                    end={clip.range.end}
                    scale={scale}
                    aspect={frame ? frame.width / frame.height : 16 / 9}
                    visibleLeft={viewport.visibleLeft - left}
                    visibleWidth={viewport.visibleWidth}
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
                      if (projectEditRecoveryGuards.isRecovering(projectId))
                        return;
                      if (disabled || event.button !== 0 || dragging) return;
                      const rect = track.current?.getBoundingClientRect();
                      if (!rect) return;
                      onSelect(index);
                      gesture.start(
                        event,
                        index,
                        edge,
                        rect.left + left + (edge === 'end' ? clipWidth : 0),
                      );
                    }}
                    onLostPointerCapture={gesture.lostCapture}
                  />
                ))}
              </div>
            );
          })}
          <div
            className="pointer-events-none absolute top-0 z-20 h-[116px] w-px bg-primary"
            style={{
              left: (origin + Math.max(0, Math.min(time, total))) * scale,
            }}
          >
            <div
              role="slider"
              tabIndex={0}
              aria-label="播放头"
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={Math.max(0, Math.min(time, total))}
              aria-valuetext={formatTime(time)}
              className="pointer-events-auto absolute -left-3 top-0 h-8 w-6 cursor-col-resize touch-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onKeyDown={seekKey}
              {...headSeek}
            >
              <span className="pointer-events-none absolute left-2 top-0 size-[9px] rounded-b-sm bg-primary" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
