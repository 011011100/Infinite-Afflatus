import type { NodeChange, OnNodeDrag, ReactFlowInstance } from '@xyflow/react';
import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useHoldFeedback } from '@/components/canvas/hold-feedback';
import { materialHoverGroup } from '../../../../shared/generation/join-materials';
import type {
  Point,
  ShotWorkspace,
} from '../../../../shared/generation/workspace';
import { LONG_PRESS_MS } from '../../../../shared/interaction/long-press';
import type { MaterialCanvasNode } from './use-material-flow';

type DragEvent = MouseEvent | TouchEvent | ReactMouseEvent;
const pointer = (event: DragEvent): Point | null => {
  const source = 'touches' in event ? event.touches[0] : event;
  return source ? { x: source.clientX, y: source.clientY } : null;
};

/** Dwell-to-join owns feedback and shields the new parent from the old drag's final events. */
export function useMaterialGroupHover({
  shot,
  disabled,
  flow,
  area,
  join,
  onChanges,
  finishMove,
}: {
  shot: ShotWorkspace;
  disabled: boolean;
  flow: RefObject<ReactFlowInstance<MaterialCanvasNode> | null>;
  area: RefObject<HTMLDivElement | null>;
  join: (ids: string[], groupId: string) => void;
  onChanges: (changes: NodeChange<MaterialCanvasNode>[]) => void;
  finishMove: OnNodeDrag<MaterialCanvasNode>;
}) {
  const show = useHoldFeedback();
  const latest = useRef({ shot, disabled, join, onChanges, finishMove });
  latest.current = { shot, disabled, join, onChanges, finishMove };
  const drag = useRef<{ ids: string[]; point: Point } | null>(null);
  const hover = useRef<{ id: string; since: number } | null>(null);
  const feedback = useRef<ReturnType<typeof show> | null>(null);
  const frame = useRef(0);
  const exit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const release = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const consumed = useRef(new Set<string>());
  const [groupId, setGroupId] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);

  const clearHover = useCallback(() => {
    hover.current = null;
    feedback.current?.hide();
    feedback.current = null;
    setGroupId(null);
  }, []);
  const cancel = useCallback(() => {
    cancelAnimationFrame(frame.current);
    clearTimeout(exit.current);
    drag.current = null;
    clearHover();
  }, [clearHover]);

  const tick = useCallback(
    (now: number) => {
      const current = drag.current;
      const instance = flow.current;
      const rect = area.current?.getBoundingClientRect();
      if (!current || !instance || !rect || latest.current.disabled) {
        cancel();
        return;
      }
      const { point, ids } = current;
      const inside =
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom;
      const target = inside
        ? materialHoverGroup(
            latest.current.shot,
            ids,
            instance.screenToFlowPosition(point),
          )
        : undefined;
      if (target?.id !== hover.current?.id) {
        clearHover();
        if (target) {
          hover.current = { id: target.id, since: now };
          setGroupId(target.id);
        }
      }
      if (target && hover.current) {
        // Screen-space feedback remains legible at every zoom and follows the held pointer.
        const anchor = {
          x: Math.min(rect.right - 36, Math.max(rect.left + 36, point.x + 44)),
          y: Math.min(rect.bottom - 36, Math.max(rect.top + 36, point.y + 44)),
          zoom: 1,
        };
        if (!feedback.current) feedback.current = show(anchor, 'join');
        else feedback.current.move(anchor);
        if (now - hover.current.since >= LONG_PRESS_MS) {
          consumed.current = new Set(ids);
          drag.current = null;
          hover.current = null;
          setGroupId(null);
          setSettled(true);
          feedback.current.ready();
          latest.current.join(ids, target.id);
          exit.current = setTimeout(clearHover, 140);
          return;
        }
      }
      frame.current = requestAnimationFrame(tick);
    },
    [area, flow, cancel, clearHover, show],
  );

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!drag.current) return;
      if (!(event.buttons & 1)) cancel();
      else drag.current.point = { x: event.clientX, y: event.clientY };
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', cancel, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('wheel', cancel, true);
    document.addEventListener('visibilitychange', cancel);
    return () => {
      cancel();
      clearTimeout(release.current);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', cancel, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('wheel', cancel, true);
      document.removeEventListener('visibilitychange', cancel);
    };
  }, [cancel]);
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled, cancel]);

  const start = (
    event: DragEvent,
    node: MaterialCanvasNode,
    nodes: MaterialCanvasNode[],
  ) => {
    cancel();
    clearTimeout(release.current);
    consumed.current.clear();
    setSettled(false);
    const moved = nodes.length ? nodes : node ? [node] : [];
    const point = pointer(event);
    if (
      latest.current.disabled ||
      !point ||
      !moved.length ||
      moved.some((item) => item.type !== 'material' || item.parentId)
    )
      return;
    drag.current = { ids: moved.map((item) => item.id), point };
    frame.current = requestAnimationFrame(tick);
  };
  const finish = (
    event: DragEvent,
    node: MaterialCanvasNode,
    nodes: MaterialCanvasNode[],
  ) => {
    cancel();
    setSettled(false);
    if (!consumed.current.size && node)
      latest.current.finishMove(
        'nativeEvent' in event ? event.nativeEvent : event,
        node,
        nodes,
      );
    // Selection dragging invokes both node and selection stop in the same event.
    release.current = setTimeout(() => consumed.current.clear(), 0);
  };
  return {
    groupId,
    settled,
    start,
    finish,
    changes: (changes: NodeChange<MaterialCanvasNode>[]) =>
      latest.current.onChanges(
        changes.filter(
          (change) =>
            change.type !== 'position' || !consumed.current.has(change.id),
        ),
      ),
  };
}
