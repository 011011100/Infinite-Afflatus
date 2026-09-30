import {
  MATERIAL_HEIGHT,
  MATERIAL_WIDTH,
  type ShotWorkspace,
} from './workspace-types';

/** Reorder only these member slots; unrelated nodes, assets, and groups keep their order. */
export function reorderGroupMembers(
  shot: ShotWorkspace,
  groupId: string,
  ids: string[],
): ShotWorkspace {
  const selected = new Set(ids);
  const members = shot.nodes.filter(
    (node) => node.groupId === groupId && selected.has(node.id),
  );
  if (selected.size !== ids.length || members.length !== ids.length)
    throw new Error('文本块排序包含无效成员');
  const byId = new Map(members.map((node) => [node.id, node]));
  let index = 0;
  return {
    ...shot,
    nodes: shot.nodes.map((node) => {
      if (node.groupId !== groupId || !selected.has(node.id)) return node;
      const next = byId.get(ids[index++] ?? '');
      return next ? { ...next, position: node.position } : node;
    }),
  };
}

export function editMaterialText(
  shot: ShotWorkspace,
  id: string,
  text: string,
): ShotWorkspace {
  return {
    ...shot,
    nodes: shot.nodes.map((node) =>
      node.id !== id
        ? node
        : node.type === 'text'
          ? { ...node, text }
          : { ...node, textOverride: text },
    ),
  };
}

/** Idempotent insertion also handles replayed effects when opening an image-only group. */
export function appendGroupText(
  shot: ShotWorkspace,
  groupId: string,
  id: string,
  text = '',
): ShotWorkspace {
  const group = shot.groups.find((item) => item.id === groupId);
  const members = shot.nodes.filter((node) => node.groupId === groupId);
  const count = members.length;
  if (!group || count >= 32 || shot.nodes.some((node) => node.id === id))
    return shot;
  const columns = Math.max(
    1,
    Math.min(3, Math.floor((group.width - 24) / (MATERIAL_WIDTH + 16))),
  );
  let slot = 0;
  let position = { x: 20, y: 52 };
  while (
    members.some(
      (node) =>
        position.x < node.position.x + MATERIAL_WIDTH &&
        position.x + MATERIAL_WIDTH > node.position.x &&
        position.y < node.position.y + MATERIAL_HEIGHT &&
        position.y + MATERIAL_HEIGHT > node.position.y,
    )
  ) {
    slot++;
    position = {
      x: 20 + (slot % columns) * (MATERIAL_WIDTH + 16),
      y: 52 + Math.floor(slot / columns) * (MATERIAL_HEIGHT + 16),
    };
  }
  return {
    ...shot,
    groups: shot.groups.map((item) =>
      item.id === groupId
        ? {
            ...item,
            height: Math.max(item.height, position.y + MATERIAL_HEIGHT + 20),
          }
        : item,
    ),
    nodes: [
      ...shot.nodes,
      {
        id,
        groupId,
        type: 'text',
        text,
        position,
      },
    ],
  };
}
