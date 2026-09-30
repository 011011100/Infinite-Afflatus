import { useLayoutEffect, useMemo, useRef } from 'react';
import type { FilmstripCache } from './filmstrip-cache';
import { filmstripTiles } from './filmstrip-layout';

export function Filmstrip({
  cache,
  source,
  start,
  end,
  scale,
  aspect,
  visibleLeft,
  visibleWidth,
}: {
  cache: FilmstripCache<HTMLCanvasElement>;
  source: string;
  start: number;
  end: number;
  scale: number;
  aspect: number;
  visibleLeft: number;
  visibleWidth: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const owner = useRef({});
  const strip = useMemo(
    () => filmstripTiles(start, end, scale, visibleLeft, visibleWidth, aspect),
    [start, end, scale, visibleLeft, visibleWidth, aspect],
  );
  const requests = useMemo(
    () =>
      strip.tiles.map((tile) => ({
        key: `${source}@${tile.time}`,
        source,
        time: tile.time,
      })),
    [source, strip],
  );
  const paint = useRef(() => {});
  paint.current = () => {
    const element = canvas.current;
    if (!element || !strip.width) return;
    const density = window.devicePixelRatio || 1;
    element.width = Math.max(1, Math.ceil(strip.width * density));
    element.height = Math.ceil(64 * density);
    const context = element.getContext('2d');
    if (!context) return;
    context.scale(density, density);
    for (const tile of strip.tiles) {
      const image = cache.get(`${source}@${tile.time}`);
      if (!image) continue;
      // Each source-time cell repeats only its own sampled frame when zoomed.
      // Preserve aspect ratio; clip cells at the changing trim boundaries.
      const cellWidth = Math.max(32, (image.width / image.height) * 64);
      context.save();
      context.beginPath();
      context.rect(tile.left - strip.left, 0, tile.width, 64);
      context.clip();
      for (let x = tile.left; x < tile.left + tile.width; x += cellWidth)
        context.drawImage(image, x - strip.left, 0, cellWidth, 64);
      context.restore();
    }
  };
  useLayoutEffect(() => {
    cache.request(owner.current, requests);
    paint.current();
  }, [cache, requests]);
  useLayoutEffect(() => {
    const subscription = owner.current;
    let frame = 0;
    const unsubscribe = cache.subscribe(() => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          paint.current();
        });
    });
    return () => {
      unsubscribe();
      cache.release(subscription);
      cancelAnimationFrame(frame);
    };
  }, [cache]);
  return (
    <canvas
      ref={canvas}
      className="pointer-events-none absolute top-0 h-full"
      style={{ left: strip.left, width: strip.width }}
    />
  );
}
