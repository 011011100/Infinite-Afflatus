/** Sample spacing stays anchored to source time, not the changing trim boundary. */
export function filmstripTiles(
  start: number,
  end: number,
  scale: number,
  visibleLeft: number,
  visibleWidth: number,
  aspect: number,
) {
  const desiredWidth = Math.max(48, Math.min(128, 64 * aspect));
  const intervals = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300];
  const interval =
    intervals.find((value) => value * scale >= desiredWidth) ?? 600;
  const tileWidth = interval * scale;
  const width = Math.max(0, (end - start) * scale - 2);
  const left = Math.max(0, visibleLeft - tileWidth);
  const right = Math.min(width, visibleLeft + visibleWidth + tileWidth);
  if (right <= left) return { left: 0, width: 0, tiles: [] };
  const first = Math.floor((start + left / scale) / interval);
  const last = Math.ceil((start + right / scale) / interval);
  const tiles = Array.from({ length: last - first }, (_, i) => {
    const time = Number(((first + i) * interval).toFixed(3));
    return { time, left: (time - start) * scale, width: tileWidth };
  });
  return { left, width: right - left, tiles };
}
