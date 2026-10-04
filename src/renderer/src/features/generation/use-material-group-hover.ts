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
import {
  DRAG_THRESHOLD,
  HOLD_HINT_DELAY_MS,
  LONG_PRESS_MS,
} from '../../../../shared/interaction/long-press';
import type { Asset } from '../../../../shared/models';
import type { MaterialCanvasNode } from './use-material-flow';

type DragEvent = MouseEvent | TouchEvent | ReactMouseEvent;
const pointer = (event: DragEvent): Point | null => {
  const source = 'touches' in event ? event.touches[0] : event;
  return source ? { x: source.clientX, y: source.clientY } : null;
};
const movedBeyondHold = (point: Point, origin: Point) =>
  Math.hypot(point.x - origin.x, point.y - origin.y) > DRAG_THRESHOLD;

/** Like hold-to-split: show confirmation first, commit on release, cancel on movement. */
export function useMaterialGroupHover({
  shot,
  assets,
  disabled,
  flow,
  area,
  join,
  onChanges,
  finishMove,
}: {
  shot: ShotWorkspace;
  assets: Asset[];
  disabled: boolean;
  flow: RefObject<ReactFlowInstance<MaterialCanvasNode> | null>;
  area: RefObject<HTMLDivElement | null>;
  join: (ids: string[], groupId: string) => void;
  onChanges: (changes: NodeChange<MaterialCanvasNode>[]) => void;
  finishMove: OnNodeDrag<MaterialCanvasNode>;
}) {
  const show = useHoldFeedback();
  const latest = useRef({
    shot,
    assets,
    disabled,
    join,
    onChanges,
    finishMove,
  });
  latest.current = { shot, assets, disabled, join, onChanges, finishMove };
  const drag = useRef<{ ids: string[]; point: Point } | null>(null);
  const hover = useRef<{
    id: string;
    since: number;
    origin: Point;
    ready: boolean;
  } | null>(null);
  const feedback = useRef<ReturnType<typeof show> | null>(null);
  const frame = useRef(0);
  const release = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const consumed = useRef(new Set<string>());
  const [groupId, setGroupId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const clearHover = useCallback(() => {
    hover.current = null;
    feedback.current?.hide();
    feedback.current = null;
    setGroupId(null);
    setReady(false);
  }, []);
  const cancel = useCallback(() => {
    cancelAnimationFrame(frame.current);
    drag.current = null;
    clearHover();
  }, [clearHover]);

  const targetAt = useCallback(
    (point: Point, ids: string[]) => {
      const instance = flow.current;
      const rect = area.current?.getBoundingClientRect();
      if (
        !instance ||
        !rect ||
        latest.current.disabled ||
        point.x < rect.left ||
        point.x > rect.right ||
        point.y < rect.top ||
        point.y > rect.bottom
      )
        return undefined;
      return materialHoverGroup(
        latest.current.shot,
        ids,
        instance.screenToFlowPosition(point),
        latest.current.assets,
      );
    },
    [area, flow],
  );

  const tick = useCallback(
    (now: number) => {
      const current = drag.current;
      const rect = area.current?.getBoundingClientRect();
      if (!current || !rect || latest.current.disabled) {
        cancel();
        return;
      }
      const { point, ids } = current;
      const target = targetAt(point, ids);
      if (target?.id !== hover.current?.id) {
        if (hover.current?.ready) {
          cancel();
          return;
        }
        clearHover();
        if (target) {
          hover.current = {
            id: target.id,
            since: now,
            origin: point,
            ready: false,
          };
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
        const elapsed = now - hover.current.since;
        if (!feedback.current && elapsed >= HOLD_HINT_DELAY_MS)
          feedback.current = show(anchor, 'join');
        else feedback.current?.move(anchor);
        if (!hover.current.ready && elapsed >= LONG_PRESS_MS) {
          hover.current.ready = true;
          setReady(true);
          feedback.current?.ready();
        }
      }
      frame.current = requestAnimationFrame(tick);
    },
    [area, targetAt, cancel, clearHover, show],
  );

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!drag.current) return;
      if (!(event.buttons & 1)) cancel();
      else {
        const point = { x: event.clientX, y: event.clientY };
        drag.current.point = point;
        if (hover.current && movedBeyondHold(point, hover.current.origin)) {
          // Once confirmed, moving cancels this drag's join altogether; staying
          // inside the same group must not silently arm it again before release.
          if (hover.current.ready) cancel();
          else clearHover();
        }
      }
    };
    const up = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const current = drag.current;
      const pending = hover.current;
      const point = { x: event.clientX, y: event.clientY };
      const confirmed =
        current &&
        pending?.ready &&
        !movedBeyondHold(point, pending.origin) &&
        targetAt(point, current.ids)?.id === pending.id;
      if (confirmed) {
        // Pointer release precedes React Flow's mouseup position/stop callbacks.
        consumed.current = new Set(current.ids);
        latest.current.join(current.ids, pending.id);
      }
      cancel();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('wheel', cancel, true);
    document.addEventListener('visibilitychange', cancel);
    return () => {
      cancel();
      clearTimeout(release.current);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('wheel', cancel, true);
      document.removeEventListener('visibilitychange', cancel);
    };
  }, [cancel, clearHover, targetAt]);
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
    ready,
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
