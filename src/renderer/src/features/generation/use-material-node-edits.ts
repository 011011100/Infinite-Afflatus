import { useState } from 'react';
import {
  materialSize,
  resizeMaterial,
  type Size,
} from '../../../../shared/generation/node-geometry';
import type {
  CanvasLabel,
  ShotWorkspace,
} from '../../../../shared/generation/workspace';

export function useMaterialNodeEdits(
  shot: ShotWorkspace,
  blocked: boolean,
  update: (change: (shot: ShotWorkspace) => ShotWorkspace) => void,
) {
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const rename = (id: string, name: string) => {
    if (blocked) return;
    update((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === id ? { ...node, name } : node,
      ),
    }));
  };
  const resize = (id: string, size: Size, done: boolean) => {
    if (blocked) return;
    if (done) {
      update((current) => resizeMaterial(current, id, size));
      setSizes((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    } else
      setSizes((current) => ({
        ...current,
        [id]: { width: size.width, height: size.height },
      }));
  };
  const labelChange = (
    id: string,
    patch: Partial<Pick<CanvasLabel, 'name' | 'color' | 'pinned'>>,
  ) => {
    if (blocked) return;
    update((current) => ({
      ...current,
      labels: (current.labels ?? []).map((label) =>
        label.id === id ? { ...label, ...patch } : label,
      ),
    }));
  };
  const labelRemove = (id: string) => {
    if (!blocked)
      update((current) => ({
        ...current,
        labels: (current.labels ?? []).filter((label) => label.id !== id),
      }));
  };
  const groupSize = (id: string, base: Size) =>
    shot.nodes
      .filter((node) => node.groupId === id)
      .reduce(
        (size, node) => ({
          width: Math.max(
            size.width,
            node.position.x + (sizes[node.id] ?? materialSize(node)).width + 20,
          ),
          height: Math.max(
            size.height,
            node.position.y +
              (sizes[node.id] ?? materialSize(node)).height +
              20,
          ),
        }),
        base,
      );
  return { sizes, rename, resize, labelChange, labelRemove, groupSize };
}
