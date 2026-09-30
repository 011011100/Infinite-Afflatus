import {
  type PointerEvent as ReactPointerEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { type ClipTrim, changeTrim } from '../../../../../shared/canvas/trim';
import type { TimelineClip } from './timeline';

type Edge = 'start' | 'end';
interface Gesture {
  pointer: number;
  target: HTMLElement;
  x: number;
  scroll: number;
  scale: number;
  index: number;
  edge: Edge;
  clip: TimelineClip;
  value: ClipTrim;
}
interface Options {
  clips: TimelineClip[];
  scale: number;
  disabled: boolean;
  reset: number;
  scrollLeft: () => number;
  preview: (index: number, range: ClipTrim, edge: Edge) => void;
  commit: (index: number, range: ClipTrim) => void;
  cancel: () => void;
  active: (active: boolean) => void;
}

/** A pointer owns its edge until release; acknowledgements never replace its baseline. */
export function useTrimGesture(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const gesture = useRef<Gesture | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const finish = useRef((cancel: boolean) => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    if (current.target.hasPointerCapture(current.pointer))
      current.target.releasePointerCapture(current.pointer);
    setDraggingIndex(null);
    latest.current.active(false);
    if (cancel) latest.current.cancel();
    else latest.current.commit(current.index, current.value);
  }).current;
  useLayoutEffect(() => {
    const move = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointer) return;
      const delta =
        event.clientX -
        current.x +
        latest.current.scrollLeft() -
        current.scroll;
      current.value = changeTrim(
        current.clip.range,
        current.edge,
        current.clip.range[current.edge] + delta / current.scale,
        current.clip.duration,
      );
      latest.current.preview(current.index, current.value, current.edge);
    };
    const up = (event: PointerEvent) => {
      if (gesture.current?.pointer !== event.pointerId) return;
      move(event);
      finish(false);
    };
    const pointerCancel = (event: PointerEvent) => {
      if (gesture.current?.pointer === event.pointerId) finish(true);
    };
    const cancel = () => finish(true);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && gesture.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish(true);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', pointerCancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    return () => {
      cancel();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', pointerCancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
    };
  }, [finish]);
  useLayoutEffect(() => {
    if (options.disabled || options.reset) finish(true);
  }, [options.disabled, options.reset, finish]);
  return {
    dragging: draggingIndex !== null,
    draggingIndex,
    start: (
      event: ReactPointerEvent<HTMLElement>,
      index: number,
      edge: Edge,
    ) => {
      if (latest.current.disabled || event.button !== 0 || gesture.current)
        return;
      const clip = latest.current.clips[index];
      if (!clip) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = {
        pointer: event.pointerId,
        target: event.currentTarget,
        x: event.clientX,
        scroll: latest.current.scrollLeft(),
        scale: latest.current.scale,
        index,
        edge,
        clip,
        value: clip.range,
      };
      setDraggingIndex(index);
      latest.current.active(true);
    },
    lostCapture: (event: ReactPointerEvent<HTMLElement>) => {
      if (gesture.current?.pointer === event.pointerId) finish(true);
    },
  };
}
