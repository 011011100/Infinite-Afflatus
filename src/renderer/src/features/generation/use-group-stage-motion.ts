import { type RefObject, useLayoutEffect, useRef } from 'react';

type Origin = { x: number; y: number; width: number; height: number };
export function useGroupStageMotion(
  ref: RefObject<HTMLDialogElement | null>,
  origin: () => Origin,
  onClose: () => void,
) {
  const callbacks = useRef({ origin, onClose });
  callbacks.current = { origin, onClose };
  const alive = useRef(false);
  const closing = useRef(false);
  const animations = useRef<Animation[]>([]);
  const pose = (element: HTMLElement) => {
    const from = callbacks.current.origin();
    const rect = element.getBoundingClientRect();
    return `translate(${from.x + from.width / 2 - rect.x - rect.width / 2}px, ${from.y + from.height / 2 - rect.y - rect.height / 2}px) scale(${Math.max(0.16, Math.min(0.55, from.width / rect.width))})`;
  };
  const poseRef = useRef(pose);
  poseRef.current = pose;
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    alive.current = true;
    closing.current = false;
    dialog.showModal();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    animations.current = [
      ...dialog.querySelectorAll<HTMLElement>('[data-stage-panel]'),
    ].map((panel) =>
      panel.animate(
        [
          { opacity: 0, transform: reduced ? 'none' : poseRef.current(panel) },
          { opacity: 1, transform: 'none' },
        ],
        { duration: reduced ? 100 : 340, easing: 'cubic-bezier(.2,.8,.2,1)' },
      ),
    );
    return () => {
      alive.current = false;
      animations.current.forEach((animation) => {
        animation.cancel();
      });
      dialog.close();
    };
  }, [ref]);
  return () => {
    const dialog = ref.current;
    if (!dialog || closing.current) return;
    closing.current = true;
    dialog
      .querySelectorAll<HTMLMediaElement>('video,audio')
      .forEach((media) => {
        media.pause();
      });
    const panels = [
      ...dialog.querySelectorAll<HTMLElement>('[data-stage-panel]'),
    ];
    const start = panels.map((panel) => ({
      transform: getComputedStyle(panel).transform,
      opacity: getComputedStyle(panel).opacity,
    }));
    animations.current.forEach((animation) => {
      animation.cancel();
    });
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    animations.current = panels.map((panel, i) =>
      panel.animate(
        [
          start[i] ?? {},
          { opacity: 0, transform: reduced ? 'none' : poseRef.current(panel) },
        ],
        {
          duration: reduced ? 80 : 200,
          easing: 'cubic-bezier(.4,0,.8,.2)',
          fill: 'forwards',
        },
      ),
    );
    void Promise.allSettled(
      animations.current.map((animation) => animation.finished),
    ).then(() => {
      if (alive.current && closing.current) callbacks.current.onClose();
    });
  };
}
