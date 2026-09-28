import { useLayoutEffect, useRef } from 'react';
import type { ThumbnailFrame } from '../decode-thumbnail';

export function Filmstrip({ frame }: { frame: ThumbnailFrame | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    if (!canvas.current || !frame) return;
    const element = canvas.current;
    const observer = new ResizeObserver(() => {
      element.width = Math.max(
        1,
        Math.min(4096, Math.ceil(element.clientWidth)),
      );
      element.height = 64;
      const context = element.getContext('2d');
      if (!context) return;
      const width = (64 * frame.image.width) / frame.image.height;
      for (let x = 0; x < element.width; x += width)
        context.drawImage(frame.image, x, 0, width, 64);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame]);
  return <canvas ref={canvas} className="absolute inset-0 size-full" />;
}
