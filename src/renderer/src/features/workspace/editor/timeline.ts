import { type ClipTrim, clipRange } from '../../../../../shared/canvas/trim';
import type { Asset } from '../../../../../shared/models';

export interface TimelineClip {
  asset: Asset;
  duration: number;
  range: ClipTrim;
  offset: number;
  length: number;
}

export function buildTimeline(
  assets: Asset[],
  durations: Map<string, number>,
  trims: Record<string, ClipTrim> = {},
): TimelineClip[] {
  let offset = 0;
  return assets.map((asset) => {
    const duration = durations.get(asset.id);
    if (!duration || !Number.isFinite(duration))
      throw new Error('无法读取视频时长');
    const range = clipRange(duration, trims[asset.id]);
    const length = range.end - range.start;
    const clip = { asset, duration, range, offset, length };
    offset += length;
    return clip;
  });
}

export function totalDuration(clips: TimelineClip[]): number {
  const last = clips.at(-1);
  return last ? last.offset + last.length : 0;
}

export function locateTime(clips: TimelineClip[], time: number) {
  const bounded = Math.max(0, Math.min(time, totalDuration(clips)));
  const index = Math.max(
    0,
    clips.findIndex(
      (clip, i) =>
        bounded < clip.offset + clip.length || i === clips.length - 1,
    ),
  );
  const clip = clips[index];
  return {
    index,
    sourceTime: clip ? clip.range.start + bounded - clip.offset : 0,
  };
}

export function formatTime(seconds: number): string {
  const tenths = Math.max(0, Math.round(seconds * 10));
  return `${String(Math.floor(tenths / 600)).padStart(2, '0')}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
}

export function rulerStep(pixelsPerSecond: number): number {
  return (
    [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600].find(
      (step) => step * pixelsPerSecond >= 60,
    ) ?? 3600
  );
}

/** Left trims move the leading side; right trims move the trailing side.
 * The ruler shares this origin, so clips stay contiguous in playback time.
 */
export function timelineOrigin(clips: TimelineClip[]): number {
  return clips.reduce((sum, clip) => sum + clip.range.start, 0);
}
