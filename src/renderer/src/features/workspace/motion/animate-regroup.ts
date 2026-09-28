import { gsap } from 'gsap';
import { Flip } from 'gsap/Flip';
import type { CanvasPatch } from '../../../../../shared/canvas/model';
import { bridgePath, motionPieces, surfacePath } from './geometry';
import { type CardSnapshot, pieceSurface } from './snapshot';

gsap.registerPlugin(Flip);
const duration = 0.44;

export function animateRegroup(
  root: HTMLElement,
  layer: SVGSVGElement,
  patch: CanvasPatch,
  before: Map<string, CardSnapshot>,
  after: Map<string, CardSnapshot>,
  state: Flip.FlipState,
  complete: () => void,
) {
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  layer.append(group);
  const path = (className: string) => {
    const element = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'path',
    );
    element.setAttribute('class', className);
    group.append(element);
    return element;
  };
  const pieces = motionPieces(patch).flatMap((piece) => {
    const from = before.get(piece.before.id);
    const to = after.get(piece.after.id);
    return from && to
      ? [
          {
            ...piece,
            value: pieceSurface(from, piece.before, piece.assetIds),
            end: pieceSurface(to, piece.after, piece.assetIds),
          },
        ]
      : [];
  });
  const bridges = pieces.flatMap((piece, index) =>
    pieces
      .slice(index + 1)
      .flatMap((other) =>
        piece.before.id === other.before.id || piece.after.id === other.after.id
          ? [{ a: piece, b: other, path: path('card-liquid-bridge') }]
          : [],
      ),
  );
  const surfaces = pieces.map((piece) => ({
    ...piece,
    path: path('card-liquid-surface'),
  }));
  const elements = [...after.values()].map((card) => card.element);
  const targets = [...after.values()].flatMap((card) => [
    ...card.assets.values(),
  ]);
  const visible = targets
    .filter((item) => item.visible)
    .map((item) => item.element);
  const hidden = targets
    .filter((item) => !item.visible)
    .map((item) => item.element);
  let timeline: gsap.core.Timeline | undefined;
  const context = gsap.context(() => {}, root);
  const cleanup = () => {
    timeline?.kill();
    context.revert();
    group.remove();
    for (const element of elements) delete element.dataset.cardMorphing;
  };
  try {
    context.add(() => {
      for (const element of elements) element.dataset.cardMorphing = 'true';
      const draw = () => {
        for (const item of surfaces)
          item.path.setAttribute('d', surfacePath(item.value));
        for (const item of bridges)
          item.path.setAttribute('d', bridgePath(item.a.value, item.b.value));
      };
      draw();
      timeline = gsap.timeline({ onUpdate: draw, onComplete: complete });
      timeline.add(
        Flip.from(state, {
          targets: visible,
          absolute: true,
          scale: false,
          duration,
          ease: 'power3.out',
          prune: true,
        }),
        0,
      );
      for (const item of pieces)
        timeline.to(
          item.value,
          { ...item.end, duration, ease: 'power3.out' },
          0,
        );
      for (const card of after.values()) {
        const items = [...card.assets.entries()].filter(
          ([, item]) => item.visible,
        );
        for (const [index, [id, item]] of items.entries()) {
          const source = [...before.values()].find((from) =>
            from.assets.has(id),
          );
          const sourceIds = source
            ? [...source.assets.entries()]
                .filter(([, asset]) => asset.visible)
                .map(([id]) => id)
            : [];
          timeline.fromTo(
            item.element,
            {
              borderTopLeftRadius: sourceIds[0] === id ? 7 : 0,
              borderTopRightRadius: sourceIds.at(-1) === id ? 7 : 0,
            },
            {
              borderTopLeftRadius: index === 0 ? 7 : 0,
              borderTopRightRadius: index === items.length - 1 ? 7 : 0,
              duration,
              ease: 'power3.out',
            },
            0,
          );
        }
      }
      if (hidden.length) gsap.set(hidden, { opacity: 0 });
      for (const [id, card] of after) {
        const footer = card.element.querySelector('footer');
        const parts = pieces.filter((piece) => piece.after.id === id);
        if (!footer || !parts.length) continue;
        const x = Math.min(...parts.map((part) => part.value.x));
        const y = Math.min(...parts.map((part) => part.value.y));
        const end = Math.max(
          ...parts.map((part) => part.value.x + part.value.width),
        );
        timeline.fromTo(
          footer,
          {
            x: x - card.bounds.x,
            y: y - card.bounds.y,
            width: end - x,
            opacity: 0.35,
          },
          {
            x: 0,
            y: 0,
            width: card.bounds.width,
            opacity: 1,
            duration,
            ease: 'power3.out',
          },
          0,
        );
      }
    });
  } catch (error) {
    cleanup();
    throw error;
  }
  return cleanup;
}
