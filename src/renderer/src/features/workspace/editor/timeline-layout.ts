/** Only the retained sequence occupies scrollable time; source in-points are not padding. */
export function timelineLayout(
  viewport: number,
  initialDuration: number,
  zoom: number,
  origin: number,
  duration: number,
  heldWidth = 0,
) {
  const scale = Math.max(8, Math.min(100, viewport / initialDuration)) * zoom;
  const width = Math.max(viewport, (origin + duration) * scale, heldWidth);
  const maxScroll = Math.max(0, width - viewport);
  // A left trim may leave some breathing room, but never a whole empty viewport.
  const minScroll = Math.min(
    maxScroll,
    Math.max(0, origin * scale - viewport / 2),
  );
  return { scale, width, minScroll, maxScroll };
}

export function boundScroll(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
