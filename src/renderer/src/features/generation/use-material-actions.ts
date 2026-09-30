import type { ReactFlowInstance } from '@xyflow/react';
import { type RefObject, useState } from 'react';
import { materialPosition } from '../../../../shared/generation/material-layout';
import {
  MATERIAL_HEIGHT,
  MATERIAL_WIDTH,
  type ShotWorkspace,
} from '../../../../shared/generation/workspace';
import { message } from './errors';
import type { MaterialCanvasNode } from './use-material-flow';

export function useMaterialActions(
  shot: ShotWorkspace,
  projectId: string,
  flow: RefObject<ReactFlowInstance<MaterialCanvasNode> | null>,
  area: RefObject<HTMLDivElement | null>,
  onChange: (update: (shot: ShotWorkspace) => ShotWorkspace) => void,
  select: (ids: string[]) => void,
) {
  const [importing, setImporting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const position = (count = 1) => {
    const rect = area.current?.getBoundingClientRect();
    const center =
      rect && flow.current
        ? flow.current.screenToFlowPosition({
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
          })
        : { x: 300, y: 300 };
    return materialPosition(shot, center, count);
  };
  const reveal = (nodes: { position: { x: number; y: number } }[]) => {
    const rects = [...shot.nodes.filter((node) => !node.groupId), ...nodes];
    const x = Math.min(...rects.map((node) => node.position.x));
    const y = Math.min(...rects.map((node) => node.position.y));
    void flow.current?.fitBounds(
      {
        x,
        y,
        width:
          Math.max(...rects.map((node) => node.position.x)) -
          x +
          MATERIAL_WIDTH,
        height:
          Math.max(...rects.map((node) => node.position.y)) -
          y +
          MATERIAL_HEIGHT,
      },
      {
        padding: 0.25,
        duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 0
          : 180,
      },
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
  const addAssets = (ids: string[]) => {
    if (!ids.length) return;
    const at = position(ids.length);
    const nodes = ids.map((assetId, index) => ({
      id: crypto.randomUUID(),
      type: 'asset' as const,
      assetId,
      position: {
        x: at.x + (index % 3) * (MATERIAL_WIDTH + 24),
        y: at.y + Math.floor(index / 3) * (MATERIAL_HEIGHT + 24),
      },
    }));
    onChange((current) => ({
      ...current,
      nodes: [...current.nodes, ...nodes],
    }));
    select(nodes.map((node) => node.id));
    reveal(nodes);
  };
  const importFiles = async () => {
    setImporting(true);
    try {
      const imported = await window.desktop.importReferences(projectId);
      addAssets(imported.assetIds);
      setLocalError(imported.errors.length ? imported.errors.join('\n') : null);
    } catch (reason) {
      setLocalError(message(reason));
    } finally {
      setImporting(false);
    }
  };
  return {
    addText,
    addAssets,
    importFiles,
    importing,
    localError,
    setLocalError,
  };
}
