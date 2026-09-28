import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasCard, CanvasPatch } from '../../../../shared/canvas/model';
import {
  findSnapTarget,
  joinCards,
  type SnapTarget,
} from '../../../../shared/canvas/operations';

interface DragState {
  original: CanvasCard;
  position: CanvasCard['position'];
  cancelled: boolean;
  snap: SnapTarget | null;
}

export function useCardDrag(
  cards: CanvasCard[],
  disabled: boolean,
  commit: (patch: CanvasPatch) => Promise<boolean>,
  select: (id: string) => void,
) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const current = useRef<DragState | null>(null);
  const update = useCallback((next: DragState | null) => {
    current.current = next;
    setDrag(next);
  }, []);
  const cancel = useCallback(() => {
    const active = current.current;
    if (!active) return false;
    update({
      ...active,
      cancelled: true,
      position: active.original.position,
      snap: null,
    });
    return true;
  }, [update]);
  useEffect(() => {
    // React Flow can tear down its drag listener when migration disables the canvas.
    if (disabled) update(null);
  }, [disabled, update]);

  const start = (id: string) => {
    const card = cards.find((item) => item.id === id);
    if (disabled || !card) return;
    select(id);
    update({
      original: card,
      position: card.position,
      cancelled: false,
      snap: null,
    });
  };
  const move = (position: CanvasCard['position'], zoom: number) => {
    const active = current.current;
    if (!active || active.cancelled) return;
    update({
      ...active,
      position,
      snap: findSnapTarget({ ...active.original, position }, cards, zoom),
    });
  };
  const stop = async (position: CanvasCard['position'], zoom: number) => {
    const active = current.current;
    if (!active || active.cancelled || disabled) {
      update(null);
      return;
    }
    // A click or a tiny hand movement must never merge adjacent cards.
    if (
      Math.hypot(
        position.x - active.original.position.x,
        position.y - active.original.position.y,
      ) *
        zoom <=
      5
    ) {
      update(null);
      return;
    }
    const snap = findSnapTarget({ ...active.original, position }, cards, zoom);
    const target = cards.find((card) => card.id === snap?.targetId);
    const patch =
      target && snap
        ? joinCards(active.original, target, snap.side)
        : {
            before: [active.original],
            after: [{ ...active.original, position }],
          };
    const moved =
      active.original.position.x !== position.x ||
      active.original.position.y !== position.y;
    if (snap || moved) {
      const saved = await commit(patch);
      if (saved) select(patch.after[0]?.id ?? active.original.id);
    }
    update(null);
  };
  return { drag, start, move, stop, cancel };
}
