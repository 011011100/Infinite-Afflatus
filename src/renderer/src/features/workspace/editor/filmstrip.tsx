import { useLayoutEffect, useRef } from 'react';
import type { ThumbnailFrame } from '../decode-thumbnail';

export function Filmstrip({
  frame,
  sourceOffset,
}: {
  frame: ThumbnailFrame | undefined;
  sourceOffset: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const paint = useRef(() => {});
  paint.current = () => {
    const element = canvas.current;
    if (!element || !frame) return;
    const { width, height } = element.getBoundingClientRect();
    if (!width || !height) return;
    const density = window.devicePixelRatio || 1;
    element.width = Math.max(1, Math.min(4096, Math.ceil(width * density)));
    element.height = Math.max(1, Math.ceil(height * density));
    const context = element.getContext('2d');
    if (!context) return;
    // Keep source artwork anchored while its visible window is trimmed.
    // No pixel export: local video thumbnails may be origin-tainted.
    const pattern = context.createPattern(frame.image, 'repeat-x');
    if (!pattern) return;
    const tileScale = height / frame.image.height;
    const tileWidth = frame.image.width * tileScale;
    pattern.setTransform(
      new DOMMatrix()
        .translate(-(sourceOffset % tileWidth), 0)
        .scale(tileScale),
    );
    context.setTransform(
      element.width / width,
      0,
      0,
      element.height / height,
      0,
      0,
    );
    context.fillStyle = pattern;
    context.fillRect(0, 0, width, height);
  };
  useLayoutEffect(() => {
    // Repaint before the new trim boundary becomes visible, not a frame later.
    void frame;
    void sourceOffset;
    paint.current();
  }, [frame, sourceOffset]);
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(() => paint.current());
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <canvas ref={canvas} className="absolute inset-0 size-full" />;
}
