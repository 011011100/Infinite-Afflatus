import type { Viewport } from '../models';
import {
  emptyGenerationDraft,
  type GenerationDraft,
  type GenerationParameters,
  validateGenerationDraft,
} from './draft';

export type Point = { x: number; y: number };
export type MaterialNode = { id: string; position: Point; groupId?: string } & (
  | { type: 'text'; text: string }
  | { type: 'asset'; assetId: string }
);
export interface GenerationGroup {
  id: string;
  position: Point;
  width: number;
  height: number;
  parameters: GenerationParameters;
}
export interface ShotWorkspace {
  id: string;
  name: string;
  /** Existing videos keep their shot materials when cards are split or joined. */
  sourceAssetId?: string;
  position: Point;
  viewport: Viewport;
  nodes: MaterialNode[];
  groups: GenerationGroup[];
}
export interface GenerationWorkspace {
  version: 1;
  revision: number;
  shots: ShotWorkspace[];
}
export const MATERIAL_WIDTH = 260;
export const MATERIAL_HEIGHT = 244;
export const emptyWorkspace = (): GenerationWorkspace => ({
  version: 1,
  revision: 0,
  shots: [],
});
export function newShot(
  id: string,
  name: string,
  position: Point,
  sourceAssetId?: string,
): ShotWorkspace {
  return {
    id,
    name,
    position,
    ...(sourceAssetId ? { sourceAssetId } : {}),
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: sourceAssetId
      ? [
          {
            id: sourceAssetId,
            type: 'asset',
            assetId: sourceAssetId,
            position: { x: 80, y: 100 },
          },
        ]
      : [],
    groups: [],
  };
}

/** Convert the old project-level form once, without dropping its text or references. */
export function workspaceFromDraft(
  projectId: string,
  draft: GenerationDraft,
): GenerationWorkspace {
  if (!draft.prompt && !draft.referenceIds.length) return emptyWorkspace();
  const shot = newShot(projectId, '镜头 01', { x: 100, y: 380 });
  shot.nodes = draft.referenceIds.map((assetId, index) => ({
    id: assetId,
    type: 'asset',
    assetId,
    position: { x: 80 + index * 288, y: 100 },
  }));
  if (draft.prompt)
    shot.nodes.push({
      id: `prompt:${projectId}`,
      type: 'text',
      text: draft.prompt,
      position: { x: 80 + shot.nodes.length * 288, y: 100 },
    });
  const grouped = groupMaterials(
    shot,
    shot.nodes.map((node) => node.id),
    `group:${projectId}`,
  );
  const group = grouped.groups[0];
  if (group) group.parameters = draft.parameters;
  return { ...emptyWorkspace(), shots: [grouped] };
}

export function groupMaterials(
  shot: ShotWorkspace,
  ids: string[],
  groupId: string,
): ShotWorkspace {
  const selected = shot.nodes.filter(
    (node) => ids.includes(node.id) && !node.groupId,
  );
  if (!selected.length || selected.length > 32)
    throw new Error('请选择 1–32 张未分组的素材卡片');
  const columns = Math.min(3, selected.length);
  const position = {
    x: Math.min(...selected.map((n) => n.position.x)) - 20,
    y: Math.min(...selected.map((n) => n.position.y)) - 52,
  };
  const group: GenerationGroup = {
    id: groupId,
    position,
    width: columns * (MATERIAL_WIDTH + 16) + 24,
    height: Math.ceil(selected.length / columns) * (MATERIAL_HEIGHT + 16) + 56,
    parameters: emptyGenerationDraft().parameters,
  };
  return {
    ...shot,
    groups: [...shot.groups, group],
    nodes: shot.nodes.map((node) => {
      const index = selected.findIndex((n) => n.id === node.id);
      return index < 0
        ? node
        : {
            ...node,
            groupId,
            position: {
              x: 20 + (index % columns) * (MATERIAL_WIDTH + 16),
              y: 52 + Math.floor(index / columns) * (MATERIAL_HEIGHT + 16),
            },
          };
    }),
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
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9:-]{1,100}$/.test(id);
const point = (value: Point) =>
  !!value &&
  Number.isFinite(value.x) &&
  Number.isFinite(value.y) &&
  Math.abs(value.x) < 1e8 &&
  Math.abs(value.y) < 1e8;
export function validateWorkspace(value: unknown): GenerationWorkspace {
  const doc = value as GenerationWorkspace;
  if (
    doc?.version !== 1 ||
    !Number.isSafeInteger(doc.revision) ||
    doc.revision < 0 ||
    !Array.isArray(doc.shots) ||
    doc.shots.length > 500
  )
    throw new Error('镜头素材画布无效');
  const shotIds = new Set<string>();
  const sources = new Set<string>();
  for (const shot of doc.shots) {
    if (
      !shot ||
      !validId(shot.id) ||
      shotIds.has(shot.id) ||
      typeof shot.name !== 'string' ||
      !shot.name.trim() ||
      shot.name.length > 100 ||
      !point(shot.position) ||
      !point(shot.viewport) ||
      !Number.isFinite(shot.viewport.zoom) ||
      shot.viewport.zoom < 0.25 ||
      shot.viewport.zoom > 2 ||
      !Array.isArray(shot.nodes) ||
      shot.nodes.length > 500 ||
      !Array.isArray(shot.groups) ||
      shot.groups.length > 100
    )
      throw new Error('镜头素材画布无效');
    shotIds.add(shot.id);
    if (shot.sourceAssetId !== undefined) {
      if (!validId(shot.sourceAssetId) || sources.has(shot.sourceAssetId))
        throw new Error('镜头视频引用无效');
      sources.add(shot.sourceAssetId);
    }
    const ids = new Set<string>();
    for (const group of shot.groups) {
      if (
        !group ||
        !validId(group.id) ||
        ids.has(group.id) ||
        !point(group.position) ||
        !Number.isFinite(group.width) ||
        !Number.isFinite(group.height) ||
        group.width < 280 ||
        group.height < 280 ||
        group.width > 10000 ||
        group.height > 10000
      )
        throw new Error('生成组无效');
      validateGenerationDraft({
        ...emptyGenerationDraft(),
        parameters: group.parameters,
      });
      ids.add(group.id);
      const members = shot.nodes.filter((node) => node?.groupId === group.id);
      if (!members.length || members.length > 32)
        throw new Error('生成组需要 1–32 张素材卡片');
    }
    for (const node of shot.nodes) {
      if (
        !node ||
        !validId(node.id) ||
        ids.has(node.id) ||
        !point(node.position) ||
        (node.groupId !== undefined &&
          !shot.groups.some((group) => group.id === node.groupId)) ||
        (node.type !== 'text' && node.type !== 'asset')
      )
        throw new Error('素材节点无效');
      if (
        node.type === 'text' &&
        (typeof node.text !== 'string' || node.text.length > 10000)
      )
        throw new Error('文本卡片最多 10000 个字符');
      if (node.type === 'asset' && !validId(node.assetId))
        throw new Error('素材引用无效');
      ids.add(node.id);
    }
  }
  return structuredClone(doc);
}
