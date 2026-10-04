import type { ReactFlowInstance } from '@xyflow/react';
import { type RefObject, useRef } from 'react';
import { materialPosition } from '../../../../shared/generation/material-layout';
import {
  LABEL_SIZE,
  materialSize,
  type Size,
} from '../../../../shared/generation/node-geometry';
import {
  MATERIAL_HEIGHT,
  MATERIAL_WIDTH,
  type ShotWorkspace,
} from '../../../../shared/generation/workspace';
import type { ReferenceImportTarget } from './reference-import-target';
import type { MaterialCanvasNode } from './use-material-flow';
import { useReferenceImport } from './use-reference-import';

export function useMaterialActions(
  shot: ShotWorkspace,
  projectId: string,
  flow: RefObject<ReactFlowInstance<MaterialCanvasNode> | null>,
  area: RefObject<HTMLDivElement | null>,
  onChange: (update: (shot: ShotWorkspace) => ShotWorkspace) => void,
  select: (ids: string[]) => void,
  blocked = false,
  beginImport?: () => ReferenceImportTarget | null,
) {
  const locked = useRef(blocked);
  locked.current = blocked;
  const position = (count = 1, size?: Size) => {
    const rect = area.current?.getBoundingClientRect();
    const center =
      rect && flow.current
        ? flow.current.screenToFlowPosition({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          })
        : { x: 300, y: 300 };
    return materialPosition(shot, center, count, size);
  };
  const reveal = (
    nodes: {
      position: { x: number; y: number };
      width?: number;
      height?: number;
    }[],
  ) => {
    // Leaving freezes the page before adding the completed intake IDs. Do not
    // start a viewport animation that could write again after that final save.
    if (area.current?.closest('[inert]')) return;
    const rects = [...shot.nodes.filter((node) => !node.groupId), ...nodes];
    const x = Math.min(...rects.map((node) => node.position.x));
    const y = Math.min(...rects.map((node) => node.position.y));
    void flow.current?.fitBounds(
      {
        x,
        y,
        width:
          Math.max(
            ...rects.map((node) => node.position.x + materialSize(node).width),
          ) - x,
        height:
          Math.max(
            ...rects.map((node) => node.position.y + materialSize(node).height),
          ) - y,
      },
      {
        padding: 0.25,
        duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 0
          : 180,
      },
    );
  };
  const addLabel = () => {
    const id = crypto.randomUUID();
    const at = position(1, LABEL_SIZE);
    onChange((current) => ({
      ...current,
      labels: [
        ...(current.labels ?? []),
        { id, name: '标签', color: '#2563eb', pinned: false, position: at },
      ],
    }));
    select([id]);
    void flow.current?.setCenter(
      at.x + LABEL_SIZE.width / 2,
      at.y + LABEL_SIZE.height / 2,
      { zoom: flow.current.getZoom(), duration: 0 },
    );
  };
  const addText = () => {
    const id = crypto.randomUUID();
    const at = position();
    onChange((current) => ({
      ...current,
      nodes: [...current.nodes, { id, type: 'text', text: '', position: at }],
    }));
    select([id]);
    reveal([{ position: at }]);
  };
  const assetNodes = (ids: string[]) => {
    const at = position(ids.length);
    return ids.map((assetId, index) => ({
      id: crypto.randomUUID(),
      type: 'asset' as const,
      assetId,
      position: {
        x: at.x + (index % 3) * (MATERIAL_WIDTH + 24),
        y: at.y + Math.floor(index / 3) * (MATERIAL_HEIGHT + 24),
      },
    }));
  };
  const addAssets = (ids: string[]) => {
    if (!ids.length) return;
    const nodes = assetNodes(ids);
    onChange((current) => ({
      ...current,
      nodes: [...current.nodes, ...nodes],
    }));
    select(nodes.map((node) => node.id));
    reveal(nodes);
  };
  const importing = useReferenceImport(projectId, () => {
    if (locked.current) return null;
    const target = beginImport
      ? beginImport()
      : {
          append: (nodes: ReturnType<typeof assetNodes>) => {
            if (locked.current) return false;
            onChange((current) => ({
              ...current,
              nodes: [...current.nodes, ...nodes],
            }));
            return true;
          },
          finish: () => {},
        };
    if (!target) return null;
    let nodes: ReturnType<typeof assetNodes> | null = null;
    return {
      accept: (ids) => {
        nodes ??= assetNodes(ids);
        if (!target.append(nodes)) return false;
        if (nodes.length) {
          select(nodes.map((node) => node.id));
          if (!locked.current) reveal(nodes);
        }
        return true;
      },
      finish: target.finish,
    };
  });
  return {
    addText,
    addLabel,
    addAssets,
    ...importing,
  };
}
