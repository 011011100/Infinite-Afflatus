import type { ClipTrim } from '../../../../../shared/canvas/trim';
import { advanceTrimDrag, type TrimDrag } from './trim-drag';

/** Follow a fast-moving trim edge immediately, independently of the idle speed. */
export function trimFollowDelta(
  edgeX: number,
  left: number,
  right: number,
): number {
  return edgeX - Math.max(left, Math.min(right, edgeX));
}

/** Symmetric hot zones; a stationary pointer continues scrolling after a drag. */
export function edgeScrollSpeed(
  x: number,
  left: number,
  right: number,
): number {
  const zone = Math.min(56, (right - left) / 4);
  if (zone <= 0) return 0;
  if (x < left + zone) return -600 * Math.min(1, (left + zone - x) / zone) ** 2;
  if (x > right - zone)
    return 600 * Math.min(1, (x - right + zone) / zone) ** 2;
  return 0;
}

/** Stop scrolling at media limits, not after a whole empty viewport appears. */
export function trimScrollDelta(
  drag: TrimDrag,
  delta: number,
  scale: number,
  range: ClipTrim,
  edge: 'start' | 'end',
  duration: number,
): number {
  const next = advanceTrimDrag(drag, delta, scale, range, edge, duration);
  return (next.time - drag.time) * scale;
}
