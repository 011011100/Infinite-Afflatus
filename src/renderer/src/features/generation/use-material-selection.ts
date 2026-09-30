import type { ReactFlowInstance } from '@xyflow/react';
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { isMac } from '@/lib/platform';
import {
  RightSelection,
  type SelectionBox,
} from '../../../../shared/interaction/right-selection';
import type { MaterialCanvasNode } from './use-material-flow';

const controls =
  'button, input, textarea, select, a, video, audio, [contenteditable="true"], .react-flow__panel, .generation-group-settings';
const nodeId = (target: EventTarget | null) =>
  target instanceof Element
    ? (target.closest('.react-flow__node')?.getAttribute('data-id') ?? null)
    : null;

/** Right-button selection is separate from React Flow's left-button pan/drag. */
export function useMaterialSelection(
  area: RefObject<HTMLDivElement | null>,
  flow: RefObject<ReactFlowInstance<MaterialCanvasNode> | null>,
  selected: string[],
  select: (ids: string[]) => void,
) {
  const gesture = useRef(new RightSelection());
  const latest = useRef({ selected, select });
  latest.current = { selected, select };
  const contextNode = useRef<string | null>(null);
  const captured = useRef<number | null>(null);
  const [box, setBox] = useState<SelectionBox | null>(null);
  const [open, setOpen] = useState(false);
  const selectContextNode = () => {
    const id = contextNode.current;
    if (id && !latest.current.selected.includes(id))
      latest.current.select([id]);
  };
  useEffect(() => {
    const surface = area.current;
    const releaseCapture = () => {
      const id = captured.current;
      captured.current = null;
      if (id !== null && surface?.hasPointerCapture(id))
        surface.releasePointerCapture(id);
    };
    const apply = (
      selection: NonNullable<ReturnType<RightSelection['move']>>,
    ) => {
      const instance = flow.current;
      const rect = surface?.getBoundingClientRect();
      if (!instance || !rect) return;
      const { box } = selection;
      const from = instance.screenToFlowPosition({ x: box.x, y: box.y });
      const to = instance.screenToFlowPosition({
        x: box.x + box.width,
        y: box.y + box.height,
      });
      // React Flow treats a zero-area rectangle as contained by every node.
      const ids =
        box.width > 0 && box.height > 0
          ? instance
              .getIntersectingNodes(
                { ...from, width: to.x - from.x, height: to.y - from.y },
                true,
              )
              .map((node) => node.id)
          : [];
      const next = [
        ...new Set([...(selection.additive ? selection.before : []), ...ids]),
      ];
      if (next.join(',') !== latest.current.selected.join(','))
        latest.current.select(next);
      setBox({ ...box, x: box.x - rect.left, y: box.y - rect.top });
    };
    const move = (event: PointerEvent) => {
      const selection = gesture.current.move(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      if (selection) {
        event.preventDefault();
        apply(selection);
      }
    };
    const up = (event: PointerEvent) => {
      const result = gesture.current.release(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      if (!result) return;
      if (result.selection) apply(result.selection);
      setBox(null);
      releaseCapture();
      if (result.openMenu) {
        const id = contextNode.current;
        if (id && !latest.current.selected.includes(id))
          latest.current.select([id]);
        setOpen(true);
      }
    };
    const cancel = () => {
      const before = gesture.current.cancel();
      if (before) latest.current.select(before);
      setBox(null);
      releaseCapture();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key);
    surface?.addEventListener('lostpointercapture', cancel);
    return () => {
      gesture.current.cancel();
      releaseCapture();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key);
      surface?.removeEventListener('lostpointercapture', cancel);
    };
  }, [area, flow]);

  return {
    box,
    open,
    onOpenChange: (next: boolean, details: { reason: string }) => {
      // This trigger normally closes a long-held right click on mouseup. Here release opens it.
      if (!next && details.reason === 'cancel-open') return;
      if (next && gesture.current.contextMenu() !== 'open') return;
      if (next) selectContextNode();
      setOpen(next);
    },
    onPointerDownCapture: (event: ReactPointerEvent<HTMLDivElement>) => {
      gesture.current.resetMenu();
      const target = event.target;
      contextNode.current = nodeId(target);
      if (
        event.button !== 2 ||
        !(target instanceof Element) ||
        !target.closest('.react-flow') ||
        target.closest(controls)
      )
        return;
      setOpen(false);
      gesture.current.start(
        event.pointerId,
        { x: event.clientX, y: event.clientY },
        latest.current.selected,
        isMac ? event.metaKey : event.ctrlKey,
      );
      captured.current = event.pointerId;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onContextMenuCapture: (event: ReactMouseEvent<HTMLDivElement>) => {
      const policy = gesture.current.contextMenu();
      if (policy === 'suppress') {
        event.preventDefault();
        event.stopPropagation();
      } else if (!gesture.current.active)
        contextNode.current = nodeId(event.target) ?? contextNode.current;
    },
  };
}
