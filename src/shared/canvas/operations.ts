import { type CanvasCard, type CanvasPatch, cardWidth } from './model';

export interface SnapTarget {
  targetId: string;
  side: 'left' | 'right';
}

/** Distances stay constant on screen as the canvas zoom changes. */
export function findSnapTarget(
  moving: CanvasCard,
  cards: CanvasCard[],
  zoom: number,
): SnapTarget | null {
  let best: { score: number; snap: SnapTarget } | undefined;
  for (const target of cards) {
    if (target.id === moving.id) continue;
    const vertical = Math.abs(target.position.y - moving.position.y) * zoom;
    if (vertical > 40) continue;
    const gaps = {
      left:
        Math.abs(moving.position.x + cardWidth(moving) - target.position.x) *
        zoom,
      right:
        Math.abs(moving.position.x - target.position.x - cardWidth(target)) *
        zoom,
    };
    for (const side of ['left', 'right'] as const) {
      const score = gaps[side] + vertical * 0.5;
      if (gaps[side] <= 28 && (!best || score < best.score))
        best = { score, snap: { targetId: target.id, side } };
    }
  }
  return best?.snap ?? null;
}

export function joinCards(
  moving: CanvasCard,
  target: CanvasCard,
  side: SnapTarget['side'],
): CanvasPatch {
  const assetIds =
    side === 'left'
      ? [...moving.assetIds, ...target.assetIds]
      : [...target.assetIds, ...moving.assetIds];
  const combined = { ...target, assetIds };
  // Keep the target's opposite edge stationary when adding to the left.
  if (side === 'left')
    combined.position = {
      x: target.position.x + cardWidth(target) - cardWidth(combined),
      y: target.position.y,
    };
  return { before: [moving, target], after: [combined] };
}

export function splitSelectedAsset(
  card: CanvasCard,
  assetId: string,
  createId: () => string,
): CanvasPatch {
  const selectedIndex = card.assetIds.indexOf(assetId);
  if (card.assetIds.length < 2 || selectedIndex < 0)
    throw new Error('请先选中组合中要拆分的片段');
  // Cut at both sides of the selection; never join its former neighbours.
  const segments = [
    card.assetIds.slice(0, selectedIndex),
    [assetId],
    card.assetIds.slice(selectedIndex + 1),
  ].filter((ids) => ids.length > 0);
  let x = card.position.x;
  return {
    before: [card],
    after: segments.map((assetIds, index) => {
      const part = {
        id: index === 0 ? card.id : createId(),
        assetIds,
        position: { x, y: card.position.y },
      };
      x += cardWidth(part) + 48;
      return part;
    }),
  };
}

export function reversePatch(patch: CanvasPatch): CanvasPatch {
  return { before: patch.after, after: patch.before };
}
