import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

gsap.registerPlugin(useGSAP);

const motionQuery = '(prefers-reduced-motion: reduce)';
function subscribeMotion(change: () => void) {
  const query = window.matchMedia(motionQuery);
  query.addEventListener('change', change);
  return () => query.removeEventListener('change', change);
}
const reducedMotion = () => window.matchMedia(motionQuery).matches;

/** Only the grip and local highlight move; the clip's geometry stays exact. */
export function useTrimBoundaryFeedback(pressure: number) {
  const root = useRef<HTMLButtonElement>(null);
  const grip = useRef<SVGPathElement>(null);
  const glow = useRef<HTMLSpanElement>(null);
  const visual = useRef({ bend: 0, glow: 0 });
  const recovery = useRef<gsap.core.Tween | null>(null);
  const [settling, setSettling] = useState(false);
  const reduce = useSyncExternalStore(
    subscribeMotion,
    reducedMotion,
    () => true,
  );

  const paint = useCallback(() => {
    // The midpoint moves at most 4px; both ends stay anchored inside the clip.
    const control = 8 + (visual.current.bend * 4) / 0.75;
    grip.current?.setAttribute('d', `M8 5 C${control} 11 ${control} 21 8 27`);
    if (glow.current)
      glow.current.style.opacity = String(Math.max(0, visual.current.glow));
  }, []);

  useGSAP(
    () => {
      // Reuse one interruptible tween instead of accumulating one per move.
      recovery.current = gsap.to(visual.current, {
        bend: 0,
        glow: 0,
        duration: 0.2,
        ease: 'back.out(1.1)',
        paused: true,
        onUpdate: paint,
        onComplete: () => setSettling(false),
      });
      return () => {
        recovery.current = null;
      };
    },
    { scope: root },
  );

  useLayoutEffect(() => {
    recovery.current?.pause();
    if (pressure !== 0 || reduce) {
      visual.current.bend = reduce ? 0 : pressure;
      visual.current.glow = Math.abs(pressure);
      paint();
      setSettling(false);
    } else if (visual.current.bend !== 0 || visual.current.glow !== 0) {
      setSettling(true);
      recovery.current?.invalidate().restart();
    }
  }, [pressure, reduce, paint]);

  return { root, grip, glow, settling };
}
