import { LABEL_SIZE } from '../../../../../shared/generation/node-geometry';
import type {
  CanvasLabel,
  Point,
} from '../../../../../shared/generation/workspace';
import type { Viewport } from '../../../../../shared/models';

export type ViewSize = { width: number; height: number };
export type LabelMarker = {
  label: CanvasLabel;
  x: number;
  y: number;
  angle: number;
  edge: 'top' | 'bottom' | 'left' | 'right' | null;
};
export const labelCenter = (label: CanvasLabel): Point => ({
  x: label.position.x + LABEL_SIZE.width / 2,
  y: label.position.y + LABEL_SIZE.height / 2,
});

/** Project offscreen labels along a ray from the viewport center, then separate collisions. */
export function labelMarkers(
  labels: CanvasLabel[],
  view: Viewport,
  size: ViewSize,
): LabelMarker[] {
  const cx = size.width / 2,
    cy = size.height / 2;
  const halfW = Math.max(1, cx - 90),
    halfH = Math.max(1, cy - 86);
  const markers = labels.map((label): LabelMarker => {
    const center = labelCenter(label);
    const x = center.x * view.zoom + view.x,
      y = center.y * view.zoom + view.y;
    const dx = x - cx,
      dy = y - cy;
    const offscreen = Math.abs(dx) > halfW || Math.abs(dy) > halfH;
    const scale = offscreen
      ? Math.min(
          halfW / Math.max(0.001, Math.abs(dx)),
          halfH / Math.max(0.001, Math.abs(dy)),
        )
      : 1;
    const edge = !offscreen
      ? null
      : Math.abs(dx) / halfW > Math.abs(dy) / halfH
        ? dx < 0
          ? 'left'
          : 'right'
        : dy < 0
          ? 'top'
          : 'bottom';
    return {
      label,
      x: cx + dx * scale,
      y: cy + dy * scale,
      angle: (Math.atan2(dy, dx) * 180) / Math.PI + 90,
      edge,
    };
  });
  for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
    const horizontal = edge === 'top' || edge === 'bottom';
    const axis = horizontal ? 'x' : 'y';
    const start = horizontal ? 90 : 86;
    const end = (horizontal ? size.width : size.height) - start;
    const step = horizontal ? 168 : 42;
    const perLane = Math.max(1, Math.floor((end - start) / step) + 1);
    const group = markers
      .filter((marker) => marker.edge === edge)
      .sort((a, b) => a[axis] - b[axis]);
    for (let offset = 0; offset < group.length; offset += perLane) {
      const lane = group.slice(offset, offset + perLane);
      let previous = start - step;
      for (const marker of lane) {
        marker[axis] = Math.max(previous + step, marker[axis]);
        previous = marker[axis];
      }
      let next = end + step;
      for (const marker of [...lane].reverse()) {
        marker[axis] = Math.min(next - step, marker[axis]);
        next = marker[axis];
      }
      for (const marker of lane) {
        const inset = Math.floor(offset / perLane) * (horizontal ? 42 : 168);
        if (horizontal) marker.y += edge === 'top' ? inset : -inset;
        else marker.x += edge === 'left' ? inset : -inset;
      }
    }
  }
  return markers;
}

export function labelFlight(
  from: Viewport,
  label: CanvasLabel,
  size: ViewSize,
): Viewport[] {
  const center = labelCenter(label);
  const source = {
    x: (size.width / 2 - from.x) / from.zoom,
    y: (size.height / 2 - from.y) / from.zoom,
  };
  const zoom = Math.max(0.25, from.zoom * 0.6);
  const at = (point: Point, scale: number) => ({
    x: size.width / 2 - point.x * scale,
    y: size.height / 2 - point.y * scale,
    zoom: scale,
  });
  return [at(source, zoom), at(center, zoom), at(center, from.zoom)];
}
