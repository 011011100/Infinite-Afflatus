import type { ReactFlowInstance } from '@xyflow/react';
import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import type { ShotUpdate } from '../../../../../shared/generation/shot-history';
import type { ShotWorkspace } from '../../../../../shared/generation/workspace';
import type { Asset } from '../../../../../shared/models';
import type { MaterialCanvasNode } from '../use-material-flow';
import { materialSearchTarget } from './material-search-model';

/** Wait for the search dialog to leave the top layer before returning to a node. */
export function useMaterialSearch({
  shot,
  assets,
  disabled,
  page,
  area,
  flow,
  select,
  cancelNavigation,
  update,
}: {
  shot: ShotWorkspace;
  assets: Asset[];
  disabled: boolean;
  page: RefObject<HTMLElement | null>;
  area: RefObject<HTMLDivElement | null>;
  flow: RefObject<ReactFlowInstance<MaterialCanvasNode> | null>;
  select: (ids: string[]) => void;
  cancelNavigation: () => void;
  update: ShotUpdate;
}) {
  const [open, setOpen] = useState(false);
  const pending = useRef<string | null>(null);
  const latest = useRef({ shot, assets, disabled, select, update });
  latest.current = { shot, assets, disabled, select, update };
  useLayoutEffect(() => {
    if (open || !pending.current) return;
    const id = pending.current;
    pending.current = null;
    const frame = requestAnimationFrame(() => {
      const current = latest.current;
      const root = page.current;
      const container = area.current;
      const instance = flow.current;
      if (
        current.disabled ||
        !root?.isConnected ||
        root.closest('[inert]') ||
        !container ||
        !instance ||
        document.querySelector('dialog[open]')
      )
        return;
      const target = materialSearchTarget(current.shot, current.assets, id);
      if (!target) return;
      current.select([id]);
      const node = [
        ...container.querySelectorAll<HTMLElement>('.react-flow__node'),
      ].find((element) => element.dataset.id === id);
      (node ?? root).focus({ preventScroll: true });
      const bounds = container.getBoundingClientRect();
      const zoom = instance.getZoom();
      const viewport = {
        x: bounds.width / 2 - (target.position.x + target.width / 2) * zoom,
        y: bounds.height / 2 - (target.position.y + target.height / 2) * zoom,
        zoom,
      };
      // Search is an explicit jump, not a node edit or a long camera animation.
      void instance.setViewport(viewport, { duration: 0 });
      current.update((value) => ({ ...value, viewport }));
    });
    return () => cancelAnimationFrame(frame);
  }, [open, page, area, flow]);
  return {
    open,
    show: () => {
      if (latest.current.disabled) return;
      cancelNavigation();
      pending.current = null;
      setOpen(true);
    },
    close: () => setOpen(false),
    choose: (id: string) => {
      pending.current = id;
      setOpen(false);
    },
  };
}
