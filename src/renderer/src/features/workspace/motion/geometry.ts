import type { CanvasPatch } from '../../../../../shared/canvas/model';

export interface Surface {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  right: number;
}

export function regrouping(patch: CanvasPatch): boolean {
  return (
    patch.before.length !== patch.after.length ||
    patch.before.some((before) => {
      const after = patch.after.find((card) => card.id === before.id);
      return !after || before.assetIds.join() !== after.assetIds.join();
    })
  );
}

/** Each contiguous piece has one source and one destination, including undo. */
export function motionPieces(patch: CanvasPatch) {
  return patch.before.flatMap((before) =>
    patch.after.flatMap((after) => {
      const assetIds = before.assetIds.filter((id) =>
        after.assetIds.includes(id),
      );
      return assetIds.length ? [{ before, after, assetIds }] : [];
    }),
  );
}

export function surfacePath(box: Surface): string {
  const { x, y, width: w, height: h } = box;
  const left = Math.min(box.left, w / 2, h / 2);
  const right = Math.min(box.right, w / 2, h / 2);
  return `M${x + left},${y} H${x + w - right} Q${x + w},${y} ${x + w},${y + right}
    V${y + h - right} Q${x + w},${y + h} ${x + w - right},${y + h}
    H${x + left} Q${x},${y + h} ${x},${y + h - left}
    V${y + left} Q${x},${y} ${x + left},${y} Z`;
}

/** A short liquid neck on the white footer, never a blur over the video. */
export function bridgePath(a: Surface, b: Surface): string {
  const [left, right] = a.x <= b.x ? [a, b] : [b, a];
  const x1 = left.x + left.width - 1;
  const x2 = right.x + 1;
  const gap = x2 - x1;
  const y1 = left.y + left.height - 20;
  const y2 = right.y + right.height - 20;
  if (gap <= 0 || gap >= 44 || Math.abs(y2 - y1) > 42) return '';
  const strength = 1 - gap / 44;
  const half = 19 * Math.sqrt(strength);
  const neck = 16 * strength ** 2;
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  return `M${x1},${y1 - half}
    C${midX},${y1 - half} ${midX},${midY - neck} ${midX},${midY - neck}
    C${midX},${midY - neck} ${midX},${y2 - half} ${x2},${y2 - half}
    L${x2},${y2 + half}
    C${midX},${y2 + half} ${midX},${midY + neck} ${midX},${midY + neck}
    C${midX},${midY + neck} ${midX},${y1 + half} ${x1},${y1 + half} Z`;
}
