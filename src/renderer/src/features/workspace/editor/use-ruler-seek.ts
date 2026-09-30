import { type PointerEvent, useEffect, useRef } from 'react';

/** Sample pointer motion once per display frame, but never drop the release. */
export function useRulerSeek(seekAt: (x: number, final: boolean) => void) {
  const seek = useRef(seekAt);
  seek.current = seekAt;
  const drag = useRef<{ id: number; x: number } | null>(null);
  const frame = useRef<number | null>(null);

  const cancelFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  const finish = (event: PointerEvent<HTMLDivElement>, flush: boolean) => {
    if (drag.current?.id !== event.pointerId) return;
    cancelFrame();
    drag.current = null;
    if (flush) seek.current(event.clientX, true);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  useEffect(() => {
    const clear = () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      drag.current = null;
    };
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('blur', clear);
      clear();
    };
  }, []);

  return {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || drag.current) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX };
      seek.current(event.clientX, false);
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      if (drag.current?.id !== event.pointerId) return;
      drag.current.x = event.clientX;
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (drag.current) seek.current(drag.current.x, false);
      });
    },
    onPointerUp: (event: PointerEvent<HTMLDivElement>) => finish(event, true),
    onPointerCancel: (event: PointerEvent<HTMLDivElement>) =>
      finish(event, false),
    onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) =>
      finish(event, false),
  };
}
