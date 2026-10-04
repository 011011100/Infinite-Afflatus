import type { Asset } from '../models';
import type { MaterialNode } from './workspace-types';

/** Local image settings; constructing a provider request belongs to its adapter. */
export const IMAGE_MODELS = ['seedream-5.0-lite', 'seedream-4.5'] as const;
export const IMAGE_RATIOS = [
  'adaptive',
  '1:1',
  '4:3',
  '3:4',
  '16:9',
  '9:16',
  '3:2',
  '2:3',
  '21:9',
] as const;
export const IMAGE_RESOLUTIONS = ['2K', '3K', '4K'] as const;
export const MAX_IMAGE_REFERENCES = 14;

export interface ImageGenerationParameters {
  model: (typeof IMAGE_MODELS)[number];
  ratio: (typeof IMAGE_RATIOS)[number];
  resolution: (typeof IMAGE_RESOLUTIONS)[number];
}

export function defaultImageParameters(): ImageGenerationParameters {
  return { model: 'seedream-5.0-lite', ratio: '1:1', resolution: '2K' };
}

export function validateImageParameters(
  value: unknown,
): ImageGenerationParameters {
  const parameters = value as ImageGenerationParameters;
  if (
    !parameters ||
    !IMAGE_MODELS.includes(parameters.model) ||
    !IMAGE_RATIOS.includes(parameters.ratio) ||
    !IMAGE_RESOLUTIONS.includes(parameters.resolution) ||
    (parameters.model === 'seedream-4.5' && parameters.resolution === '3K')
  )
    throw new Error('图片生成参数无效');
  return { ...parameters };
}

export type ImageInputAsset = Pick<Asset, 'id' | 'kind'>;

export function imageReferenceCount(
  nodes: MaterialNode[],
  assets: ImageInputAsset[],
): number {
  const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
  return nodes.filter(
    (node) => node.type === 'asset' && kinds.get(node.assetId) === 'image',
  ).length;
}

/** Validate every input together so adding a card cannot bypass reference limits. */
export function imageInputError(
  nodes: MaterialNode[],
  assets: ImageInputAsset[],
): string | null {
  const kinds = new Map(assets.map((asset) => [asset.id, asset.kind]));
  let images = 0;
  for (const node of nodes) {
    if (node.type === 'text') continue;
    const kind = kinds.get(node.assetId);
    if (!kind) return '参考素材尚未就绪或不存在';
    if (kind !== 'image' && kind !== 'text')
      return '图片生成只支持文本和图片素材';
    if (kind === 'image') images++;
  }
  return images > MAX_IMAGE_REFERENCES
    ? `图片生成最多支持 ${MAX_IMAGE_REFERENCES} 张参考图`
    : null;
}
