import type { CanvasCard } from '../../../../../shared/canvas/model';
import type { Surface } from './geometry';

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface CardSnapshot {
  element: HTMLElement;
  bounds: Bounds;
  assets: Map<
    string,
    { element: HTMLElement; bounds: Bounds; visible: boolean }
  >;
}

export function captureCards(
  root: HTMLElement,
  layer: SVGSVGElement,
  cards: CanvasCard[],
) {
  const matrix = layer.getScreenCTM()?.inverse();
  if (!matrix) return null;
  const bounds = (element: Element): Bounds => {
    const rect = element.getBoundingClientRect();
    const start = new DOMPoint(rect.left, rect.top).matrixTransform(matrix);
    const end = new DOMPoint(rect.right, rect.bottom).matrixTransform(matrix);
    return {
      x: start.x,
      y: start.y,
      width: end.x - start.x,
      height: end.y - start.y,
    };
  };
  const result = new Map<string, CardSnapshot>();
  for (const card of cards) {
    const element = root.querySelector<HTMLElement>(
      `[data-video-card="${card.id}"]`,
    );
    if (!element || element.dataset.cardAssets !== card.assetIds.join(','))
      return null;
    let cardBounds = bounds(element);
    const moving = element.dataset.cardMorphing === 'true';
    const assets: CardSnapshot['assets'] = new Map();
    for (const id of card.assetIds) {
      const item = element.querySelector<HTMLElement>(
        `[data-asset-id="${id}"]`,
      );
      if (!item) return null;
      const rect = bounds(item);
      assets.set(id, {
        element: item,
        bounds: rect,
        visible: moving
          ? getComputedStyle(item).opacity !== '0'
          : rect.x + rect.width > cardBounds.x + 1 &&
            rect.x < cardBounds.x + cardBounds.width - 1,
      });
    }
    if (moving) {
      const visible = [...assets.values()].filter((asset) => asset.visible);
      if (visible.length) {
        const x = Math.min(...visible.map((asset) => asset.bounds.x));
        cardBounds = {
          ...cardBounds,
          x,
          y: Math.min(...visible.map((asset) => asset.bounds.y)),
          width:
            Math.max(
              ...visible.map((asset) => asset.bounds.x + asset.bounds.width),
            ) - x,
        };
      }
    }
    result.set(card.id, { element, bounds: cardBounds, assets });
  }
  return result;
}

export function pieceSurface(
  snapshot: CardSnapshot,
  card: CanvasCard,
  ids: string[],
): Surface {
  const first = snapshot.assets.get(ids[0] ?? '')?.bounds ?? snapshot.bounds;
  const last = snapshot.assets.get(ids.at(-1) ?? '')?.bounds ?? snapshot.bounds;
  const x = Math.max(
    snapshot.bounds.x,
    Math.min(first.x, snapshot.bounds.x + snapshot.bounds.width),
  );
  const end = Math.min(
    snapshot.bounds.x + snapshot.bounds.width,
    last.x + last.width,
  );
  return {
    x,
    y: first.y,
    width: Math.max(0.01, end - x),
    height: snapshot.bounds.height,
    left: ids[0] === card.assetIds[0] ? 8 : 0,
    right: ids.at(-1) === card.assetIds.at(-1) ? 8 : 0,
  };
}
