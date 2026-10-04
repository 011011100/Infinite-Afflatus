import { emptyGenerationDraft } from './draft';
import {
  defaultImageParameters,
  type ImageInputAsset,
  imageInputError,
} from './image-generation';
import { materialPosition } from './material-layout';
import { groupGrid, materialSize } from './node-geometry';
import type {
  GenerationGroup,
  MaterialNode,
  Point,
  ShotWorkspace,
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
  const mixedKinds =
    new Set(groups.map((group) => group.kind ?? 'video')).size > 1;
  return {
    materials,
    groups,
    mixedKinds,
    canGroup:
      !mixedKinds &&
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
  options: { kind?: 'video' | 'image'; assets?: ImageInputAsset[] } = {},
): ShotWorkspace {
  const selection = materialSelection(shot, ids);
  const selected = selection.materials;
  if (!selected.length || selected.length > 32)
    throw new Error('请选择 1–32 张素材卡片（包含所选组内素材）');
  if (selection.mixedKinds)
    throw new Error('图片生成组与视频生成组不能直接合并');
  const seed =
    selection.groups.find((group) => group.id === preferredGroupId) ??
    selection.groups[0];
  const kind = options.kind ?? seed?.kind ?? 'video';
  if (seed && kind !== (seed.kind ?? 'video'))
    throw new Error('不能通过合并更改已有组的生成类型');
  if (kind === 'image') {
    const error = imageInputError(selected, options.assets ?? []);
    if (error) throw new Error(error);
  }
  if (!selection.canGroup) return shot;
  if (
    shot.groups.some((group) => group.id === groupId) ||
    shot.nodes.some((node) => node.id === groupId)
  )
    throw new Error('生成组标识重复');
  const positions = selected.map((node) => absolutePosition(shot, node));
  const layout = groupGrid(selected);
  const group: GenerationGroup = {
    id: groupId,
    position: {
      x: Math.min(...positions.map((point) => point.x)) - 20,
      y: Math.min(...positions.map((point) => point.y)) - 52,
    },
    width: layout.width,
    height: layout.height,
    ...(kind === 'image'
      ? {
          kind: 'image' as const,
          parameters: {
            ...(seed?.kind === 'image'
              ? seed.parameters
              : defaultImageParameters()),
          },
        }
      : {
          // Preserve legacy video JSON: a missing kind remains missing.
          ...(seed?.kind === 'video' ? { kind: 'video' as const } : {}),
          parameters: {
            ...(seed?.kind !== 'image' && seed
              ? seed.parameters
              : emptyGenerationDraft().parameters),
          },
        }),
  };
  const indices = new Map(selected.map((node, index) => [node.id, index]));
  const nodes = shot.nodes.map((node) => {
    const index = indices.get(node.id);
    return index === undefined
      ? node
      : {
          ...node,
          groupId,
          position: layout.positions[index] ?? node.position,
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
  const size = materialSize(node);
  const remaining = removeMaterial(shot, id);
  const absolute = absolutePosition(shot, node);
  const position = center
    ? materialPosition(remaining, center, 1, size)
    : remaining.groups.some((group) => group.id === parent.id)
      ? materialPosition(
          remaining,
          {
            x: absolute.x + size.width / 2,
            y: parent.position.y + parent.height + 36 + size.height / 2,
          },
          1,
          size,
        )
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
