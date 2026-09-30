import type { ReactFlowInstance } from '@xyflow/react';
import { type RefObject, useEffect } from 'react';
import type { MaterialCanvasNode } from './use-material-flow';

const duration = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;

export function useMaterialViewport(
  flow: RefObject<ReactFlowInstance<MaterialCanvasNode> | null>,
  area: RefObject<HTMLDivElement | null>,
  activeGroup: string | null,
  detached: { id: string; groupId?: string } | null,
) {
  useEffect(() => {
    const instance = flow.current;
    const surface = area.current;
    if (activeGroup || !detached || !instance || !surface) return;
    const viewport = instance.getViewport();
    const card = instance.getNodesBounds([detached.id]);
    const left = card.x * viewport.zoom + viewport.x;
    const top = card.y * viewport.zoom + viewport.y;
    if (
      left >= 24 &&
      top >= 24 &&
      left + card.width * viewport.zoom <= surface.clientWidth - 24 &&
      top + card.height * viewport.zoom <= surface.clientHeight - 24
    )
      return;
    // Keep the newly independent card visible together with its original group.
    const nodes = [{ id: detached.id }];
    if (detached.groupId && instance.getNode(detached.groupId))
      nodes.push({ id: detached.groupId });
    void instance.fitView({
      nodes,
      padding: 0.18,
      maxZoom: Math.min(1, viewport.zoom),
      duration: duration(),
    });
  }, [detached, flow, area, activeGroup]);
}
