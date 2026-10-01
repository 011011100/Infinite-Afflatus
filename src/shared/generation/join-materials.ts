import { materialSize } from './node-geometry';
import type { MaterialNode, Point, ShotWorkspace } from './workspace-types';

export function canJoinMaterials(
  shot: ShotWorkspace,
  ids: string[],
  groupId: string,
): boolean {
  const selected = new Set(ids);
  const incoming = shot.nodes.filter((node) => selected.has(node.id));
  return (
    selected.size > 0 &&
    incoming.length === selected.size &&
    incoming.every((node) => !node.groupId) &&
    shot.groups.some((group) => group.id === groupId) &&
    shot.nodes.filter((node) => node.groupId === groupId).length +
      incoming.length <=
      32
  );
}

/** Hit-test the pointer, not a card corner grazing a neighbouring group. */
export function materialHoverGroup(
  shot: ShotWorkspace,
  ids: string[],
  point: Point,
) {
  const target = [...shot.groups]
    .reverse()
    .find(
      (group) =>
        point.x >= group.position.x &&
        point.x <= group.position.x + group.width &&
        point.y >= group.position.y &&
        point.y <= group.position.y + group.height,
    );
  return target && canJoinMaterials(shot, ids, target.id) ? target : undefined;
}

/** Fill available space, extending downwards without moving existing members. */
function placement(node: MaterialNode, members: MaterialNode[], width: number) {
  const size = materialSize(node);
  const xs = [
    20,
    ...members.map((item) => item.position.x + materialSize(item).width + 16),
  ].sort((a, b) => a - b);
  const ys = [
    52,
    ...members.map((item) => item.position.y + materialSize(item).height + 16),
  ].sort((a, b) => a - b);
  for (const y of ys) {
    for (const x of xs) {
      if (x + size.width > width - 20) continue;
      if (
        members.every((item) => {
          const other = materialSize(item);
          return (
            x + size.width + 16 <= item.position.x ||
            x >= item.position.x + other.width + 16 ||
            y + size.height + 16 <= item.position.y ||
            y >= item.position.y + other.height + 16
          );
        })
      )
        return { x, y };
    }
  }
  return { x: 20, y: Math.max(52, ...ys) };
}

/** Keep the target identity, position, parameters, and member order when absorbing cards. */
export function joinMaterials(
  shot: ShotWorkspace,
  ids: string[],
  groupId: string,
): ShotWorkspace {
  if (!canJoinMaterials(shot, ids, groupId)) return shot;
  const group = shot.groups.find((item) => item.id === groupId);
  if (!group) return shot;
  const selected = new Set(ids);
  const incoming = shot.nodes.filter((node) => selected.has(node.id));
  const members = shot.nodes.filter((node) => node.groupId === groupId);
  const width = Math.max(
    group.width,
    ...incoming.map((node) => materialSize(node).width + 40),
  );
  let height = group.height;
  const additions = incoming.map((node) => {
    const position = placement(node, members, width);
    const added = { ...node, groupId, position };
    members.push(added);
    height = Math.max(height, position.y + materialSize(node).height + 20);
    return added;
  });
  const nodes = shot.nodes.filter((node) => !selected.has(node.id));
  const last = nodes.reduce(
    (index, node, i) => (node.groupId === groupId ? i : index),
    -1,
  );
  nodes.splice(last + 1, 0, ...additions);
  return {
    ...shot,
    nodes,
    groups: shot.groups.map((item) =>
      item.id === groupId ? { ...item, width, height } : item,
    ),
  };
}
