import { type RefObject, useLayoutEffect, useRef } from 'react';
import { instantMotion } from '@/lib/input-method';

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
    dialog.inert = false;
    dialog.dataset.open = 'false';
    const instant = instantMotion();
    dialog.dataset.instant = String(instant);
    dialog.showModal();
    void dialog.offsetWidth;
    const frame = requestAnimationFrame(() => {
      if (!closing.current) dialog.dataset.open = 'true';
    });
    animations.current = [
      ...dialog.querySelectorAll<HTMLElement>('[data-stage-panel]'),
    ].map((panel) =>
      panel.animate(
        [
          { opacity: 0, transform: instant ? 'none' : poseRef.current(panel) },
          { opacity: 1, transform: 'none' },
        ],
        { duration: instant ? 0 : 340, easing: 'cubic-bezier(.22,1,.36,1)' },
      ),
    );
    return () => {
      alive.current = false;
      cancelAnimationFrame(frame);
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
    dialog.inert = true;
    dialog.dataset.open = 'false';
    dialog.dataset.instant = String(instantMotion());
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
    if (instantMotion()) {
      callbacks.current.onClose();
      return;
    }
    animations.current = panels.map((panel, i) =>
      panel.animate(
        [start[i] ?? {}, { opacity: 0, transform: poseRef.current(panel) }],
        {
          duration: 150,
          easing: 'cubic-bezier(.22,1,.36,1)',
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
