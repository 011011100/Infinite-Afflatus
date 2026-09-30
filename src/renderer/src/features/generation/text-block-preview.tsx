import { GripVertical } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { LiftedBlock } from './use-text-block-drag';

/** The lifted surface can settle even after the drop removes its original block. */
export function TextBlockPreview({
  lifted,
  text,
}: {
  lifted: LiftedBlock | null;
  text: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<{ block: LiftedBlock; text: string } | null>(null);
  const [hidden, setHidden] = useState(false);
  if (lifted) last.current = { block: lifted, text };
  const id = lifted?.id;
  useLayoutEffect(() => {
    const element = ref.current;
    const prior = last.current;
    if (!element || !prior) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let active = true;
    let animation: Animation;
    if (id) {
      setHidden(false);
      animation = element.animate(
        [
          { opacity: 0.7, transform: 'none' },
          {
            opacity: 1,
            transform: reduced ? 'none' : 'scale(1.025) rotate(-.6deg)',
          },
        ],
        { duration: reduced ? 0 : 120 },
      );
    } else {
      const target = [
        ...(element
          .closest('dialog')
          ?.querySelectorAll<HTMLElement>('[data-text-block]') ?? []),
      ]
        .find((node) => node.dataset.textBlock === prior.block.id)
        ?.getBoundingClientRect();
      const transform =
        !reduced && target
          ? `translate(${target.x - prior.block.x}px, ${target.y - prior.block.y}px)`
          : 'none';
      animation = element.animate(
        [
          { opacity: 1, transform: getComputedStyle(element).transform },
          { opacity: 0, transform },
        ],
        {
          duration: reduced ? 0 : 150,
          easing: 'cubic-bezier(.2,.8,.2,1)',
          fill: 'forwards',
        },
      );
      void animation.finished
        .then(() => {
          if (active) setHidden(true);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
      animation.cancel();
    };
  }, [id]);
  const view = lifted ? { block: lifted, text } : hidden ? null : last.current;
  if (!view) return null;
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="group-text-lift"
      style={{
        left: view.block.x,
        top: view.block.y,
        width: view.block.width,
        height: view.block.height,
      }}
    >
      <div className="flex items-center gap-2 text-xs text-primary">
        <GripVertical className="size-4" />
        {view.block.outside ? '松手移回画布' : '调整顺序'}
      </div>
      <p className="mt-3 line-clamp-5 whitespace-pre-wrap break-words text-sm leading-7">
        {view.text}
      </p>
    </div>
  );
}
