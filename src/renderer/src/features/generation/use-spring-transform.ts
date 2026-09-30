import { type RefObject, useLayoutEffect, useRef } from 'react';

type Pose = {
  x: number;
  y: number;
  scale: number;
  rotate: number;
  opacity: number;
};
const keys: (keyof Pose)[] = ['x', 'y', 'scale', 'rotate', 'opacity'];

/** Retarget from live position and velocity, including quick wheel reversals. */
export function useSpringTransform(
  ref: RefObject<HTMLDivElement | null>,
  target: Pose,
) {
  const current = useRef({ ...target });
  const velocity = useRef<Pose>({
    x: 0,
    y: 0,
    scale: 0,
    rotate: 0,
    opacity: 0,
  });
  const latest = useRef(target);
  const { x, y, scale, rotate, opacity } = target;
  useLayoutEffect(() => {
    latest.current = { x, y, scale, rotate, opacity };
    const element = ref.current;
    if (!element) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - previous) / 1000, 1 / 30);
      previous = now;
      let moving = false;
      for (const key of keys) {
        const difference = current.current[key] - latest.current[key];
        // Analytical critically damped spring: stable even after a slow frame.
        const omega = 22;
        const b = velocity.current[key] + omega * difference;
        const decay = Math.exp(-omega * dt);
        const next = (difference + b * dt) * decay;
        velocity.current[key] =
          (velocity.current[key] - omega * b * dt) * decay;
        current.current[key] = latest.current[key] + next;
        if (Math.abs(next) > 0.001 || Math.abs(velocity.current[key]) > 0.01)
          moving = true;
      }
      if (reduced.matches || !moving) {
        current.current = { ...latest.current };
        moving = false;
      }
      const p = current.current;
      element.style.transform = `translate3d(${p.x}px, ${p.y}px, 0) rotate(${p.rotate}deg) scale(${p.scale})`;
      element.style.opacity = String(p.opacity);
      if (moving) frame = requestAnimationFrame(tick);
    };
    tick(previous);
    return () => cancelAnimationFrame(frame);
  }, [ref, x, y, scale, rotate, opacity]);
}
