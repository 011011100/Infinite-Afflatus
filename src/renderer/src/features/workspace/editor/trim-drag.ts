import type { ClipTrim } from '../../../../../shared/canvas/trim';
import { MIN_CLIP_DURATION } from '../../../../../shared/canvas/trim';

export interface TrimDrag {
  /** Keep sub-millisecond input; only the persisted range is rounded. */
  time: number;
  boundary: -1 | 0 | 1;
  pull: number;
}

/** Consume each movement at the clamped edge, so reversing has no dead zone. */
export function advanceTrimDrag(
  current: TrimDrag,
  delta: number,
  scale: number,
  range: ClipTrim,
  edge: 'start' | 'end',
  duration: number,
): TrimDrag {
  if (delta === 0) return current;
  const minimum = Math.min(MIN_CLIP_DURATION, duration);
  const lower = edge === 'start' ? 0 : range.start + minimum;
  const upper = edge === 'start' ? range.end - minimum : duration;
  const requested = current.time + delta / scale;
  const time = Math.max(lower, Math.min(upper, requested));
  const boundary =
    delta < 0 && requested <= lower
      ? -1
      : delta > 0 && requested >= upper
        ? 1
        : 0;
  return {
    time,
    boundary,
    pull: boundary
      ? (current.boundary === boundary ? current.pull : 0) +
        Math.abs(requested - time) * scale
      : 0,
  };
}

/** Signed pressure, capped at one; the first contact remains perceptible. */
export function trimBoundaryPressure(drag: TrimDrag): number {
  return drag.boundary * (0.18 + 0.82 * (1 - Math.exp(-drag.pull / 30)));
}
