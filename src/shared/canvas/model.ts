import type { Asset } from '../models';
import type { ClipTrim } from './trim';

export interface CanvasCard {
  id: string;
  position: { x: number; y: number };
  /** Playback order is explicit, independent of the card's canvas position. */
  assetIds: string[];
  trims?: Record<string, ClipTrim>;
}

export interface CanvasDocument {
  version: 1;
  revision: number;
  cards: CanvasCard[];
}

/** Compare and replace only affected cards, so imports cannot be overwritten. */
export interface CanvasPatch {
  before: CanvasCard[];
  after: CanvasCard[];
}

export const CARD_HEIGHT = 204;
export function cardWidth(card: CanvasCard): number {
  return card.assetIds.length === 1
    ? 288
    : Math.min(card.assetIds.length, 4) * 216;
}

const validId = (id: unknown): id is string =>
  typeof id === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    id,
  );

export function validateCards(value: unknown): asserts value is CanvasCard[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw new Error('画布卡片数据无效');
  const ids = new Set<string>();
  const assets = new Set<string>();
  for (const card of value) {
    if (
      !card ||
      !validId(card.id) ||
      ids.has(card.id) ||
      !card.position ||
      !Number.isFinite(card.position.x) ||
      !Number.isFinite(card.position.y) ||
      Math.abs(card.position.x) > 1e8 ||
      Math.abs(card.position.y) > 1e8 ||
      !Array.isArray(card.assetIds) ||
      !card.assetIds.length ||
      card.assetIds.length > 10000
    ) {
      throw new Error('画布卡片数据无效');
    }
    if (card.trims !== undefined) {
      if (
        !card.trims ||
        typeof card.trims !== 'object' ||
        Array.isArray(card.trims)
      )
        throw new Error('片段裁剪数据无效');
      for (const [id, trim] of Object.entries(card.trims) as [
        string,
        ClipTrim,
      ][]) {
        if (
          !card.assetIds.includes(id) ||
          !trim ||
          !Number.isFinite(trim.start) ||
          !Number.isFinite(trim.end) ||
          trim.start < 0 ||
          trim.end <= trim.start
        )
          throw new Error('片段裁剪范围无效');
      }
    }
    ids.add(card.id);
    for (const id of card.assetIds) {
      if (!validId(id) || assets.has(id))
        throw new Error('画布中的视频引用重复或无效');
      assets.add(id);
    }
  }
}

export function sameCard(a: CanvasCard, b: CanvasCard): boolean {
  return (
    a.id === b.id &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.assetIds.length === b.assetIds.length &&
    a.assetIds.every(
      (id, index) =>
        id === b.assetIds[index] &&
        a.trims?.[id]?.start === b.trims?.[id]?.start &&
        a.trims?.[id]?.end === b.trims?.[id]?.end,
    )
  );
}

/** Legacy projects and newly imported assets receive deterministic card IDs. Reads stay read-only. */
export function reconcileCanvas(
  stored: CanvasDocument | undefined,
  assets: Asset[],
): CanvasDocument {
  const canvas = stored ?? { version: 1, revision: 0, cards: [] };
  if (
    canvas.version !== 1 ||
    !Number.isSafeInteger(canvas.revision) ||
    canvas.revision < 0
  )
    throw new Error('画布版本不受支持');
  validateCards(canvas.cards);
  const videos = new Set(
    assets
      .filter((asset) => asset.kind === 'video' && asset.usage !== 'reference')
      .map((asset) => asset.id),
  );
  const placed = new Set(canvas.cards.flatMap((card) => card.assetIds));
  if ([...placed].some((id) => !videos.has(id)))
    throw new Error('画布引用了不存在的视频');
  const missing = [...videos].filter((id) => !placed.has(id));
  const bottom = canvas.cards.length
    ? Math.max(
        ...canvas.cards.map((card) => card.position.y + CARD_HEIGHT + 48),
      )
    : 100;
  const occupiedIds = new Set(canvas.cards.map((card) => card.id));
  if (missing.some((id) => occupiedIds.has(id)))
    throw new Error('新视频与画布卡片标识冲突');
  return {
    ...canvas,
    cards: [
      ...canvas.cards,
      ...missing.map((id, index) => ({
        id,
        assetIds: [id],
        position: {
          x: 100 + (index % 3) * 336,
          y: bottom + Math.floor(index / 3) * (CARD_HEIGHT + 48),
        },
      })),
    ],
  };
}

export function applyCanvasPatch(
  canvas: CanvasDocument,
  patch: CanvasPatch,
): CanvasDocument {
  if (!patch || typeof patch !== 'object') throw new Error('画布操作无效');
  validateCards(patch.before);
  validateCards(patch.after);
  if (!patch.before.length || !patch.after.length)
    throw new Error('画布操作不能为空');
  const beforeAssets = patch.before.flatMap((card) => card.assetIds).sort();
  const afterAssets = patch.after.flatMap((card) => card.assetIds).sort();
  if (
    beforeAssets.length !== afterAssets.length ||
    beforeAssets.some((id, index) => id !== afterAssets[index])
  )
    throw new Error('画布操作不能增删素材');
  for (const expected of patch.before) {
    const actual = canvas.cards.find((card) => card.id === expected.id);
    if (!actual || !sameCard(actual, expected))
      throw new Error('卡片已发生变化，请重新操作');
  }
  const affected = new Set(patch.before.map((card) => card.id));
  const cards = [
    ...canvas.cards.filter((card) => !affected.has(card.id)),
    ...patch.after,
  ];
  validateCards(cards);
  return { ...canvas, revision: canvas.revision + 1, cards };
}
