import type { ReactFlowInstance } from '@xyflow/react';
import { type RefObject, useRef, useState } from 'react';
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
import { usePendingSave } from '../lifecycle/use-pending-save';
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
  const pendingImport = useRef<Promise<boolean> | null>(null);
  // Import callbacks add material references, so finish them before saving the shot draft.
  usePendingSave(
    `导入镜头素材:${projectId}`,
    () => pendingImport.current ?? Promise.resolve(true),
    -10,
  );
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
    pendingImport.current = (async () => {
      try {
        const imported = await window.desktop.importReferences(projectId);
        addAssets(imported.assetIds);
        setLocalError(
          imported.errors.length
            ? [
                `已添加 ${imported.assetIds.length} 个素材；${imported.errors.length} 个未添加。`,
                ...imported.errors,
              ].join('\n')
            : null,
        );
        return true;
      } catch (reason) {
        setLocalError(message(reason));
        return false;
      } finally {
        setImporting(false);
      }
    })();
    await pendingImport.current;
    pendingImport.current = null;
  };
  return {
    addText,
    addLabel,
    addAssets,
    importFiles,
    importing,
    localError,
    setLocalError,
  };
}
