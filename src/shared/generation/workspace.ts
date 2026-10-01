import {
  emptyGenerationDraft,
  type GenerationDraft,
  validateGenerationDraft,
} from './draft';
import { groupMaterials } from './material-groups';
import { MAX_MATERIAL_SIZE, MIN_MATERIAL_SIZE } from './node-geometry';
import type {
  GenerationWorkspace,
  Point,
  ShotWorkspace,
} from './workspace-types';

export {
  groupMaterials,
  removeMaterial,
  ungroupMaterials,
} from './material-groups';
export * from './workspace-types';

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
      if (
        node.type === 'asset' &&
        node.textOverride !== undefined &&
        (typeof node.textOverride !== 'string' ||
          node.textOverride.length > 10000)
      )
        throw new Error('文本卡片最多 10000 个字符');
      if (
        node.name !== undefined &&
        (typeof node.name !== 'string' ||
          !node.name.trim() ||
          node.name.length > 100)
      )
        throw new Error('卡片名称需要 1–100 个字符');
      for (const key of ['width', 'height'] as const) {
        if (
          node[key] !== undefined &&
          (!Number.isFinite(node[key]) ||
            node[key] < MIN_MATERIAL_SIZE[key] ||
            node[key] > MAX_MATERIAL_SIZE[key])
        )
          throw new Error('卡片尺寸无效');
      }
      ids.add(node.id);
    }
    if (shot.labels !== undefined) {
      if (!Array.isArray(shot.labels) || shot.labels.length > 500)
        throw new Error('标签数量无效');
      for (const label of shot.labels) {
        if (
          !label ||
          !validId(label.id) ||
          ids.has(label.id) ||
          !point(label.position) ||
          typeof label.name !== 'string' ||
          !label.name.trim() ||
          label.name.length > 100 ||
          typeof label.color !== 'string' ||
          !/^#[0-9a-fA-F]{6}$/.test(label.color) ||
          typeof label.pinned !== 'boolean'
        )
          throw new Error('画布标签无效');
        ids.add(label.id);
      }
    }
  }
  return structuredClone(doc);
}
