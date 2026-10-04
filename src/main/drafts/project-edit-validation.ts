import { isAbsolute } from 'node:path';
import { type CanvasCard, validateCards } from '../../shared/canvas/model';
import type { Asset } from '../../shared/models';
import type {
  ProjectEditDraftInput,
  ProjectEditDraftRecord,
} from '../../shared/project-edit-draft';
import { validateName } from '../projects/project-service';
import { draftId, draftKey, MAX_DRAFT_BYTES } from './draft-validation';

function savedName(value: unknown): string {
  const name = validateName(value);
  if (name !== value) throw new Error('恢复草稿的已保存名称无效');
  return name;
}

function card(value: unknown): CanvasCard {
  const cards: unknown = [value];
  validateCards(cards);
  const current = cards[0];
  if (!current) throw new Error('裁剪恢复卡片无效');
  return {
    id: current.id,
    position: { x: current.position.x, y: current.position.y },
    assetIds: [...current.assetIds],
    ...(current.trims
      ? {
          trims: Object.fromEntries(
            Object.entries(current.trims).map(([id, range]) => [
              id,
              {
                start: range.start,
                end: range.end,
              },
            ]),
          ),
        }
      : {}),
  };
}

function sameStructure(a: CanvasCard, b: CanvasCard) {
  return (
    a.id === b.id &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.assetIds.length === b.assetIds.length &&
    a.assetIds.every((id, index) => id === b.assetIds[index])
  );
}

export function projectEditInput(input: unknown): ProjectEditDraftInput {
  const key = draftKey(input);
  const value = input as ProjectEditDraftInput;
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_DRAFT_BYTES)
    throw new Error('恢复草稿超过 16 MB，尚未建立恢复副本');
  if (value.kind === 'name') {
    if (typeof value.target !== 'string' || value.target.length > 100)
      throw new Error('名称恢复输入不能超过 100 个字符');
    return {
      ...key,
      kind: 'name',
      baseline: savedName(value.baseline),
      target: value.target,
      ...(value.lastSubmitted !== undefined
        ? { lastSubmitted: savedName(value.lastSubmitted) }
        : {}),
    };
  }
  if (value.kind !== 'trim') throw new Error('项目编辑恢复类型不受支持');
  const baseline = card(value.baseline);
  const target = card(value.target);
  const lastSubmitted =
    value.lastSubmitted === undefined ? undefined : card(value.lastSubmitted);
  if (
    !sameStructure(baseline, target) ||
    (lastSubmitted && !sameStructure(baseline, lastSubmitted))
  )
    throw new Error('裁剪恢复只能调整原卡片入点与出点');
  if (
    !Array.isArray(value.assets) ||
    value.assets.length !== baseline.assetIds.length
  )
    throw new Error('裁剪恢复缺少完整的原素材记录');
  const assets = value.assets.map((asset: Asset, index): Asset => {
    if (
      !asset ||
      asset.id !== baseline.assetIds[index] ||
      asset.kind !== 'video' ||
      asset.usage !== undefined ||
      typeof asset.name !== 'string' ||
      typeof asset.relativePath !== 'string' ||
      !asset.relativePath ||
      asset.relativePath.includes('\0') ||
      isAbsolute(asset.relativePath) ||
      asset.relativePath.split(/[\\/]/).includes('..') ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      typeof asset.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)
    )
      throw new Error('裁剪恢复原素材记录无效');
    return {
      id: asset.id,
      name: asset.name,
      relativePath: asset.relativePath,
      size: asset.size,
      sha256: asset.sha256,
      kind: asset.kind,
    };
  });
  return {
    ...key,
    kind: 'trim',
    baseline,
    target,
    ...(lastSubmitted ? { lastSubmitted } : {}),
    assets,
  };
}

export function projectEditRecord(input: unknown): ProjectEditDraftRecord {
  const value = input as ProjectEditDraftRecord;
  if (
    value?.format !== 'infinite-afflatus-project-edit-draft' ||
    value.version !== 1 ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt))
  )
    throw new Error('项目编辑恢复格式无效或版本不受支持，原文件已保留');
  return {
    ...projectEditInput(value),
    format: value.format,
    version: value.version,
    updatedAt: value.updatedAt,
    project: {
      id: draftId(value.project?.id),
      folder: draftId(value.project?.folder),
      name: savedName(value.project?.name),
    },
  };
}

/** Sequence equality compares authored payload, not service-generated timestamps. */
export function sameProjectEditInput(
  a: ProjectEditDraftInput,
  b: ProjectEditDraftInput,
) {
  const encode = (value: ProjectEditDraftInput) =>
    JSON.stringify(projectEditInput(value), (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    );
  return encode(a) === encode(b);
}
