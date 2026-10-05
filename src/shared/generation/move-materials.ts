import { materialSize } from './node-geometry';
import type { Point, ShotWorkspace } from './workspace-types';

/** A keyboard step changes positions only, preserving group-relative coordinates. */
export function moveMaterials(
  shot: ShotWorkspace,
  ids: readonly string[],
  delta: Readonly<Point>,
): ShotWorkspace {
  if ((!delta.x && !delta.y) || !ids.length) return shot;
  const selected = new Set(ids);
  const groups = new Map(shot.groups.map((group) => [group.id, group]));
  let changed = false;
  const move = <T extends { position: Point }>(item: T, bounds?: Point): T => {
    const position = {
      x: item.position.x + delta.x,
      y: item.position.y + delta.y,
    };
    if (bounds) {
      position.x = Math.max(0, Math.min(bounds.x, position.x));
      position.y = Math.max(0, Math.min(bounds.y, position.y));
    }
    // Keep an otherwise valid old position valid at the document's coordinate limit.
    if (!Number.isFinite(position.x) || Math.abs(position.x) >= 1e8)
      position.x = item.position.x;
    if (!Number.isFinite(position.y) || Math.abs(position.y) >= 1e8)
      position.y = item.position.y;
    if (position.x === item.position.x && position.y === item.position.y)
      return item;
    changed = true;
    return { ...item, position };
  };
  const nodes = shot.nodes.map((node) => {
    if (!selected.has(node.id)) return node;
    const parent = node.groupId ? groups.get(node.groupId) : undefined;
    // Moving the parent already moves the child's absolute position once.
    if (parent && selected.has(parent.id)) return node;
    const size = materialSize(node);
    return move(
      node,
      parent
        ? {
            x: Math.max(0, parent.width - size.width),
            y: Math.max(0, parent.height - size.height),
          }
        : undefined,
    );
  });
  const movedGroups = shot.groups.map((group) =>
    selected.has(group.id) ? move(group) : group,
  );
  const labels = shot.labels?.map((label) =>
    selected.has(label.id) && !label.pinned ? move(label) : label,
  );
  return changed
    ? {
        ...shot,
        nodes,
        groups: movedGroups,
        ...(labels ? { labels } : {}),
      }
    : shot;
}
