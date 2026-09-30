import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useLayoutEffect,
  useReducer,
  useRef,
} from 'react';
import { type ClipTrim, changeTrim } from '../../../../../shared/canvas/trim';
import type { TimelineClip } from './timeline';
import {
  edgeScrollSpeed,
  trimFollowDelta,
  trimScrollDelta,
} from './trim-auto-scroll';
import {
  advanceTrimDrag,
  type TrimDrag,
  trimBoundaryPressure,
} from './trim-drag';
import type { TrimScrollReserve } from './use-timeline-viewport';

type Edge = 'start' | 'end';
interface Gesture {
  pointer: number;
  target: HTMLElement;
  x: number;
  pointerX: number;
  initialX: number;
  edgeX: number;
  moved: boolean;
  scroll: number;
  scale: number;
  index: number;
  edge: Edge;
  clip: TimelineClip;
  value: ClipTrim;
  drag: TrimDrag;
}
interface Options {
  clips: TimelineClip[];
  scale: number;
  disabled: boolean;
  reset: number;
  scrollLeft: () => number;
  bounds: () => { left: number; right: number } | undefined;
  panBy: (delta: number) => void;
  preview: (index: number, range: ClipTrim, edge: Edge) => void;
  commit: (index: number, range: ClipTrim) => void;
  cancel: () => void;
  active: (
    active: boolean,
    reserve?: TrimScrollReserve,
    cancelled?: boolean,
  ) => void;
}

/** A pointer owns its edge until release; acknowledgements never replace its baseline. */
export function useTrimGesture(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const gesture = useRef<Gesture | null>(null);
  const animation = useRef(0);
  // The captured pointer is the source of truth. A separate state value can
  // survive Fast Refresh with an old type and falsely lock further gestures.
  const [, render] = useReducer((revision: number) => revision + 1, 0);
  const finish = useCallback((cancel: boolean) => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    cancelAnimationFrame(animation.current);
    animation.current = 0;
    if (current.target.hasPointerCapture(current.pointer))
      current.target.releasePointerCapture(current.pointer);
    render();
    latest.current.active(false, undefined, cancel);
    if (cancel) latest.current.cancel();
    else latest.current.commit(current.index, current.value);
  }, []);
  useLayoutEffect(() => {
    const advance = () => {
      const current = gesture.current;
      if (!current) return;
      const scroll = latest.current.scrollLeft();
      const scrollDelta = scroll - current.scroll;
      const delta = current.pointerX - current.x + scrollDelta;
      current.x = current.pointerX;
      current.scroll = scroll;
      const previousPressure = trimBoundaryPressure(current.drag);
      current.drag = advanceTrimDrag(
        current.drag,
        delta,
        current.scale,
        current.clip.range,
        current.edge,
        current.clip.duration,
      );
      const value = changeTrim(
        current.clip.range,
        current.edge,
        current.drag.time,
        current.clip.duration,
      );
      // Track the actual trimmed edge, not the cursor (which can leave the
      // window or keep moving after reaching a source-media limit).
      current.edgeX +=
        (value[current.edge] - current.value[current.edge]) * current.scale -
        scrollDelta;
      const bounds = latest.current.bounds();
      if (bounds) {
        const follow = trimFollowDelta(
          current.edgeX,
          bounds.left + 16,
          bounds.right - 16,
        );
        if (Math.abs(follow) > 0.001) {
          latest.current.panBy(follow);
          const followedScroll = latest.current.scrollLeft();
          current.edgeX -= followedScroll - current.scroll;
          // This scroll only reveals the already-applied trim. Consuming it
          // again on the next frame would trim twice and push the edge away.
          current.scroll = followedScroll;
        }
      }
      // Pulling against a boundary should not repeatedly seek/decode the video.
      if (value[current.edge] !== current.value[current.edge]) {
        current.value = value;
        latest.current.preview(current.index, value, current.edge);
      }
      if (previousPressure !== trimBoundaryPressure(current.drag)) render();
    };
    let lastFrame = 0;
    const tick = (now: number) => {
      animation.current = 0;
      const current = gesture.current;
      if (!current) return;
      const elapsed = Math.min(32, Math.max(0, now - lastFrame));
      lastFrame = now;
      const bounds = latest.current.bounds();
      if (bounds && current.moved) {
        const delta =
          (edgeScrollSpeed(
            current.pointerX,
            bounds.left + 16,
            bounds.right - 16,
          ) *
            elapsed) /
          1000;
        const allowed = trimScrollDelta(
          current.drag,
          delta,
          current.scale,
          current.clip.range,
          current.edge,
          current.clip.duration,
        );
        if (Math.abs(allowed) > 0.001) latest.current.panBy(allowed);
        advance();
      }
      animation.current = requestAnimationFrame(tick);
    };
    const move = (event: PointerEvent) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointer) return;
      current.pointerX = event.clientX;
      current.moved ||= Math.abs(event.clientX - current.initialX) >= 3;
      advance();
      if (current.moved && !animation.current) {
        lastFrame = performance.now();
        animation.current = requestAnimationFrame(tick);
      }
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
    dragging: gesture.current !== null,
    draggingIndex: gesture.current?.index ?? null,
    boundary: gesture.current
      ? {
          index: gesture.current.index,
          edge: gesture.current.edge,
          pressure: trimBoundaryPressure(gesture.current.drag),
        }
      : null,
    start: (
      event: ReactPointerEvent<HTMLElement>,
      index: number,
      edge: Edge,
      edgeX: number,
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
        pointerX: event.clientX,
        initialX: event.clientX,
        edgeX,
        moved: false,
        scroll: latest.current.scrollLeft(),
        scale: latest.current.scale,
        index,
        edge,
        clip,
        value: clip.range,
        drag: { time: clip.range[edge], boundary: 0, pull: 0 },
      };
      render();
      latest.current.active(true, {
        before: edge === 'start' ? clip.range.start : 0,
        after: edge === 'end' ? clip.duration - clip.range.end : 0,
      });
      // Preview once even when the first movement pushes an existing limit.
      latest.current.preview(index, clip.range, edge);
    },
    lostCapture: (event: ReactPointerEvent<HTMLElement>) => {
      if (gesture.current?.pointer === event.pointerId) finish(true);
    },
  };
}
