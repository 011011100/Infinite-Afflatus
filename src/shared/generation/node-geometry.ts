import {
  MATERIAL_HEIGHT,
  MATERIAL_WIDTH,
  type MaterialNode,
  type ShotWorkspace,
} from './workspace-types';

export const MIN_MATERIAL_SIZE = { width: 200, height: 180 };
export const MAX_MATERIAL_SIZE = { width: 1200, height: 800 };
export const LABEL_SIZE = { width: 220, height: 52 };
export type Size = { width: number; height: number };
export function materialSize(
  node: Pick<MaterialNode, 'width' | 'height'>,
): Size {
  return {
    width: node.width ?? MATERIAL_WIDTH,
    height: node.height ?? MATERIAL_HEIGHT,
  };
}

/** A resize is one document update; its parent grows enough to retain the member. */
export function resizeMaterial(
  shot: ShotWorkspace,
  id: string,
  size: Size,
): ShotWorkspace {
  const node = shot.nodes.find((item) => item.id === id);
  if (!node) return shot;
  const width = Math.max(
    MIN_MATERIAL_SIZE.width,
    Math.min(MAX_MATERIAL_SIZE.width, size.width),
  );
  const height = Math.max(
    MIN_MATERIAL_SIZE.height,
    Math.min(MAX_MATERIAL_SIZE.height, size.height),
  );
  return {
    ...shot,
    nodes: shot.nodes.map((item) =>
      item.id === id ? { ...item, width, height } : item,
    ),
    groups: shot.groups.map((group) =>
      group.id === node.groupId
        ? {
            ...group,
            width: Math.max(group.width, node.position.x + width + 20),
            height: Math.max(group.height, node.position.y + height + 20),
          }
        : group,
    ),
  };
}

/** Variable-size cards retain their dimensions when combined, without overlapping. */
export function groupGrid(nodes: MaterialNode[]) {
  const columns = Math.min(3, nodes.length);
  const widths = Array.from({ length: columns }, (_, col) =>
    Math.max(
      ...nodes
        .filter((_, i) => i % columns === col)
        .map((node) => materialSize(node).width),
    ),
  );
  const heights = Array.from(
    { length: Math.ceil(nodes.length / columns) },
    (_, row) =>
      Math.max(
        ...nodes
          .slice(row * columns, (row + 1) * columns)
          .map((node) => materialSize(node).height),
      ),
  );
  return {
    width: widths.reduce((sum, w) => sum + w + 16, 24),
    height: heights.reduce((sum, h) => sum + h + 16, 56),
    positions: nodes.map((_, i) => ({
      x: 20 + widths.slice(0, i % columns).reduce((sum, w) => sum + w + 16, 0),
      y:
        52 +
        heights
          .slice(0, Math.floor(i / columns))
          .reduce((sum, h) => sum + h + 16, 0),
    })),
  };
}
