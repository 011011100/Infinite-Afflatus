import { useNodes, useReactFlow, ViewportPortal } from '@xyflow/react';
import type { MaterialCanvasNode } from './use-material-flow';

/** Keep the collective selection visible after the drag rectangle disappears. */
export function MaterialSelectionFrame({ dragging }: { dragging: boolean }) {
  const nodes = useNodes<MaterialCanvasNode>();
  const { getNodesBounds } = useReactFlow<MaterialCanvasNode>();
  const selected = nodes.filter((node) => node.selected && !node.hidden);
  // A selected parent already encloses its children with the permanent group frame.
  const ids = new Set(selected.map((node) => node.id));
  const roots = selected.filter(
    (node) => !node.parentId || !ids.has(node.parentId),
  );
  if (dragging || roots.length < 2) return null;
  const bounds = getNodesBounds(roots);
  const padding = 12;
  return (
    <ViewportPortal>
      <div
        aria-hidden="true"
        data-material-selection-frame
        className="pointer-events-none absolute rounded-2xl border-2 border-dashed border-primary/70"
        style={{
          left: bounds.x - padding,
          top: bounds.y - padding,
          width: bounds.width + padding * 2,
          height: bounds.height + padding * 2,
        }}
      />
    </ViewportPortal>
  );
}
