import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { BlockDrag } from '../../../../shared/interaction/block-drag';
import { LONG_PRESS_MS } from '../../../../shared/interaction/long-press';

type Point = { x: number; y: number };
export interface LiftedBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  outside: boolean;
}
export function useTextBlockDrag(
  surface: RefObject<HTMLDivElement | null>,
  list: RefObject<HTMLDivElement | null>,
  ids: string[],
  disabled: boolean,
  reorder: (ids: string[]) => void,
  detach: (id: string, at?: Point) => void,
) {
  const latest = useRef({ ids, reorder, detach });
  latest.current = { ids, reorder, detach };
  const gesture = useRef(new BlockDrag());
  const cleanup = useRef(() => {});
  const [lifted, setLifted] = useState<LiftedBlock | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const [holding, setHolding] = useState<string | null>(null);
  const cancel = () => {
    gesture.current.cancel();
    cleanup.current();
    setLifted(null);
    setOrder(null);
    setHolding(null);
  };
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  const signature = ids.join('|');
  useEffect(() => {
    if (disabled || !signature) cancelRef.current();
    return () => cancelRef.current();
  }, [disabled, signature]);
  const begin = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    if (
      disabled ||
      event.button !== 0 ||
      !event.isPrimary ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    if (
      (event.target as Element).closest('textarea,input,a,[data-block-action]')
    )
      return;
    cancel();
    const block = event.currentTarget;
    const rect = block.getBoundingClientRect();
    const start = { x: event.clientX, y: event.clientY };
    let pointer = start;
    let active = false;
    let outside = false;
    let nextOrder = [...latest.current.ids];
    let frame = 0;
    let previous = performance.now();
    gesture.current.start(event.pointerId, start.x, start.y, previous);
    setHolding(id);
    const update = () => {
      const bounds = surface.current?.getBoundingClientRect();
      const scroller = list.current;
      if (!bounds || !scroller) return;
      outside =
        pointer.x < bounds.left - 20 ||
        pointer.x > bounds.right + 20 ||
        pointer.y < bounds.top - 20 ||
        pointer.y > bounds.bottom + 20;
      setLifted({
        id,
        x: rect.x + pointer.x - start.x,
        y: rect.y + pointer.y - start.y,
        width: rect.width,
        height: Math.min(rect.height, 220),
        outside,
      });
      if (outside) return;
      const others = [
        ...scroller.querySelectorAll<HTMLElement>('[data-text-block]'),
      ].filter((el) => el.dataset.textBlock !== id);
      const before = others.find((el) => {
        const box = el.getBoundingClientRect();
        return pointer.y < box.top + box.height / 2;
      });
      const next = others.map((el) => el.dataset.textBlock ?? '');
      const index = before
        ? next.indexOf(before.dataset.textBlock ?? '')
        : next.length;
      next.splice(index, 0, id);
      if (next.join('|') !== nextOrder.join('|')) {
        nextOrder = next;
        setOrder(next);
      }
    };
    const tick = (now: number) => {
      const dt = Math.min(now - previous, 32) / 1000;
      previous = now;
      const scroller = list.current;
      const bounds = scroller?.getBoundingClientRect();
      if (
        bounds &&
        scroller &&
        !outside &&
        pointer.x >= bounds.left &&
        pointer.x <= bounds.right
      ) {
        const speed =
          pointer.y < bounds.top + 48
            ? -Math.min(1, (bounds.top + 48 - pointer.y) / 48)
            : pointer.y > bounds.bottom - 48
              ? Math.min(1, (pointer.y - bounds.bottom + 48) / 48)
              : 0;
        if (speed) {
          scroller.scrollTop += speed * 480 * dt;
          update();
        }
      }
      frame = requestAnimationFrame(tick);
    };
    const timer = setTimeout(() => {
      if (!gesture.current.lift(performance.now())) return;
      active = true;
      setHolding(null);
      block.setPointerCapture(event.pointerId);
      setOrder(nextOrder);
      update();
      frame = requestAnimationFrame(tick);
    }, LONG_PRESS_MS);
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      pointer = { x: next.clientX, y: next.clientY };
      if (!gesture.current.move(next.pointerId, pointer.x, pointer.y)) {
        if (!gesture.current.active) cancel();
        return;
      }
      next.preventDefault();
      update();
    };
    const release = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      pointer = { x: next.clientX, y: next.clientY };
      if (active) update();
      const commit = gesture.current.release(
        next.pointerId,
        pointer.x,
        pointer.y,
      );
      cancel();
      if (
        !commit ||
        pointer.x < 0 ||
        pointer.y < 0 ||
        pointer.x > innerWidth ||
        pointer.y > innerHeight
      )
        return;
      if (outside) latest.current.detach(id, pointer);
      else latest.current.reorder(nextOrder);
    };
    const key = (next: KeyboardEvent) => {
      if (next.key === 'Escape') {
        next.preventDefault();
        next.stopImmediatePropagation();
        cancel();
      }
    };
    window.addEventListener('pointermove', move, {
      capture: true,
      passive: false,
    });
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    window.addEventListener('keydown', key, true);
    block.addEventListener('lostpointercapture', cancel);
    cleanup.current = () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
      window.removeEventListener('keydown', key, true);
      block.removeEventListener('lostpointercapture', cancel);
      if (block.hasPointerCapture(event.pointerId))
        block.releasePointerCapture(event.pointerId);
    };
  };
  return { lifted, order, holding, begin, cancel };
}
