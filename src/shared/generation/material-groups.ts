import { emptyGenerationDraft } from './draft';
import { materialPosition } from './material-layout';
import {
  type GenerationGroup,
  MATERIAL_HEIGHT,
  MATERIAL_WIDTH,
  type MaterialNode,
  type Point,
  type ShotWorkspace,
} from './workspace-types';

/** Selecting a group includes every member; selecting parent + child never duplicates it. */
export function materialSelection(shot: ShotWorkspace, ids: string[]) {
  const selected = new Set(ids);
  const materials = shot.nodes.filter(
    (node) =>
      selected.has(node.id) || (node.groupId && selected.has(node.groupId)),
  );
  const sourceIds = new Set(materials.map((node) => node.groupId));
  const groups = shot.groups
    .filter((group) => sourceIds.has(group.id))
    .sort(
      (a, b) =>
        a.position.x - b.position.x ||
        a.position.y - b.position.y ||
        a.id.localeCompare(b.id),
    );
  return {
    materials,
    groups,
    canGroup:
      materials.length > 0 &&
      materials.length <= 32 &&
      (groups.length > 1 || materials.some((node) => !node.groupId)),
  };
}

function absolutePosition(shot: ShotWorkspace, node: MaterialNode) {
  const parent = shot.groups.find((group) => group.id === node.groupId);
  return {
    x: node.position.x + (parent?.position.x ?? 0),
    y: node.position.y + (parent?.position.y ?? 0),
  };
}

export function groupMaterials(
  shot: ShotWorkspace,
  ids: string[],
  groupId: string,
  preferredGroupId?: string | null,
): ShotWorkspace {
  const selection = materialSelection(shot, ids);
  const selected = selection.materials;
  if (!selected.length || selected.length > 32)
    throw new Error('请选择 1–32 张素材卡片（包含所选组内素材）');
  if (!selection.canGroup) return shot;
  if (
    shot.groups.some((group) => group.id === groupId) ||
    shot.nodes.some((node) => node.id === groupId)
  )
    throw new Error('生成组标识重复');
  const seed =
    selection.groups.find((group) => group.id === preferredGroupId) ??
    selection.groups[0];
  const positions = selected.map((node) => absolutePosition(shot, node));
  const columns = Math.min(3, selected.length);
  const group: GenerationGroup = {
    id: groupId,
    position: {
      x: Math.min(...positions.map((point) => point.x)) - 20,
      y: Math.min(...positions.map((point) => point.y)) - 52,
    },
    width: columns * (MATERIAL_WIDTH + 16) + 24,
    height: Math.ceil(selected.length / columns) * (MATERIAL_HEIGHT + 16) + 56,
    parameters: { ...(seed?.parameters ?? emptyGenerationDraft().parameters) },
  };
  const indices = new Map(selected.map((node, index) => [node.id, index]));
  const nodes = shot.nodes.map((node) => {
    const index = indices.get(node.id);
    return index === undefined
      ? node
      : {
          ...node,
          groupId,
          position: {
            x: 20 + (index % columns) * (MATERIAL_WIDTH + 16),
            y: 52 + Math.floor(index / columns) * (MATERIAL_HEIGHT + 16),
          },
        };
  });
  return {
    ...shot,
    nodes,
    groups: [
      ...shot.groups.filter((parent) =>
        nodes.some((node) => node.groupId === parent.id),
      ),
      group,
    ],
  };
}

/** Detach one material, keeping other members and parameters exactly where they were. */
export function detachMaterial(
  shot: ShotWorkspace,
  id: string,
  center?: Point,
): ShotWorkspace {
  const node = shot.nodes.find((item) => item.id === id);
  const parent = shot.groups.find((group) => group.id === node?.groupId);
  if (!node || !parent) return shot;
  const remaining = removeMaterial(shot, id);
  const absolute = absolutePosition(shot, node);
  const position = center
    ? materialPosition(remaining, center)
    : remaining.groups.some((group) => group.id === parent.id)
      ? materialPosition(remaining, {
          x: absolute.x + MATERIAL_WIDTH / 2,
          y: parent.position.y + parent.height + 36 + MATERIAL_HEIGHT / 2,
        })
      : absolute;
  const { groupId: _, ...material } = node;
  return {
    ...shot,
    groups: remaining.groups,
    nodes: shot.nodes.map((item) =>
      item.id === id ? { ...material, position } : item,
    ),
  };
}

export function ungroupMaterials(
  shot: ShotWorkspace,
  groupId: string,
): ShotWorkspace {
  const group = shot.groups.find((item) => item.id === groupId);
  if (!group) return shot;
  return {
    ...shot,
    groups: shot.groups.filter((item) => item.id !== groupId),
    nodes: shot.nodes.map((node) => {
      if (node.groupId !== groupId) return node;
      const { groupId: _, ...material } = node;
      return {
        ...material,
        position: {
          x: node.position.x + group.position.x,
          y: node.position.y + group.position.y,
        },
      };
    }),
  };
}
export function removeMaterial(shot: ShotWorkspace, id: string): ShotWorkspace {
  const nodes = shot.nodes.filter((node) => node.id !== id);
  return {
    ...shot,
    nodes,
    groups: shot.groups.filter((group) =>
      nodes.some((node) => node.groupId === group.id),
    ),
  };
}
