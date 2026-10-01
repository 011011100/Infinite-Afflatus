import { useReactFlow } from '@xyflow/react';
import { MoveDiagonal2 } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import {
  MAX_MATERIAL_SIZE,
  MIN_MATERIAL_SIZE,
  type Size,
} from '../../../../shared/generation/node-geometry';

/** Keep one captured pointer and one size owner; React Flow only measures the resulting box. */
export function MaterialResize({
  size,
  resize,
}: {
  size: Size;
  resize: (size: Size, done: boolean) => void;
}) {
  const flow = useReactFlow();
  const button = useRef<HTMLButtonElement>(null);
  const frame = useRef(0);
  const latest = useRef(resize);
  latest.current = resize;
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    zoom: number;
    before: Size;
    current: Size;
  } | null>(null);
  const constrain = (next: Size): Size => ({
    width: Math.max(
      MIN_MATERIAL_SIZE.width,
      Math.min(MAX_MATERIAL_SIZE.width, next.width),
    ),
    height: Math.max(
      MIN_MATERIAL_SIZE.height,
      Math.min(MAX_MATERIAL_SIZE.height, next.height),
    ),
  });
  const end = useCallback((cancel = false) => {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    latest.current(cancel ? active.before : active.current, true);
    if (button.current?.hasPointerCapture(active.id))
      button.current.releasePointerCapture(active.id);
  }, []);
  useEffect(() => {
    const cancel = () => end(true);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture.current) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    return () => {
      gesture.current = null;
      cancelAnimationFrame(frame.current);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
    };
  }, [end]);
  return (
    <button
      ref={button}
      type="button"
      className="material-resize nodrag nopan absolute bottom-0 right-0 grid size-[22px] touch-none place-items-center rounded-tl-lg rounded-br-xl bg-primary text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      style={{ cursor: 'nwse-resize' }}
      title="拖动调整大小，也可用方向键"
      aria-label="调整卡片大小"
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.stopPropagation();
        button.current?.focus({ preventScroll: true });
        gesture.current = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          zoom: flow.getZoom(),
          before: size,
          current: size,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const active = gesture.current;
        if (!active || active.id !== event.pointerId) return;
        active.current = constrain({
          width: active.before.width + (event.clientX - active.x) / active.zoom,
          height:
            active.before.height + (event.clientY - active.y) / active.zoom,
        });
        if (!frame.current)
          frame.current = requestAnimationFrame(() => {
            frame.current = 0;
            const current = gesture.current;
            // Publish before ResizeObserver runs, not during its next measurement delivery.
            if (current)
              flushSync(() => latest.current(current.current, false));
          });
      }}
      onPointerUp={(event) => {
        const active = gesture.current;
        if (active?.id !== event.pointerId) return;
        active.current = constrain({
          width: active.before.width + (event.clientX - active.x) / active.zoom,
          height:
            active.before.height + (event.clientY - active.y) / active.zoom,
        });
        end();
      }}
      onPointerCancel={() => end(true)}
      onLostPointerCapture={() => end(true)}
      onKeyDown={(event) => {
        if (
          !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
            event.key,
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 40 : 10;
        latest.current(
          constrain({
            width:
              size.width +
              (event.key === 'ArrowRight'
                ? step
                : event.key === 'ArrowLeft'
                  ? -step
                  : 0),
            height:
              size.height +
              (event.key === 'ArrowDown'
                ? step
                : event.key === 'ArrowUp'
                  ? -step
                  : 0),
          }),
          true,
        );
      }}
    >
      <MoveDiagonal2 className="size-3.5" />
    </button>
  );
}
