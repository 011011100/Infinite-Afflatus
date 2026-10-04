import { useGSAP } from '@gsap/react';
import { gsap } from 'gsap';
import { Flip } from 'gsap/Flip';
import { type RefObject, useCallback, useEffect, useRef } from 'react';
import type { CanvasPatch } from '../../../../../shared/canvas/model';
import { animateRegroup } from './animate-regroup';
import { regrouping } from './geometry';
import { captureCards } from './snapshot';

gsap.registerPlugin(useGSAP, Flip);
const noop = () => {};

/** Wait for React Flow's new DOM, then invert its layout before the next paint. */
export function useCardMorph(
  rootRef: RefObject<HTMLElement | null>,
  disabled: boolean,
) {
  const active = useRef<() => void>(noop);
  const cancel = useCallback(() => {
    const stop = active.current;
    active.current = noop;
    stop();
  }, []);
  useGSAP(
    () => {
      const root = rootRef.current;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
      root?.addEventListener('pointerdown', cancel, true);
      root?.addEventListener('wheel', cancel, true);
      window.addEventListener('resize', cancel);
      window.addEventListener('blur', cancel);
      reduced.addEventListener('change', cancel);
      return () => {
        cancel();
        root?.removeEventListener('pointerdown', cancel, true);
        root?.removeEventListener('wheel', cancel, true);
        window.removeEventListener('resize', cancel);
        window.removeEventListener('blur', cancel);
        reduced.removeEventListener('change', cancel);
      };
    },
    { scope: rootRef, dependencies: [cancel] },
  );
  useEffect(() => {
    if (disabled) cancel();
  }, [disabled, cancel]);

  return useCallback(
    (patch: CanvasPatch): ((saved: boolean) => void) => {
      const root = rootRef.current;
      const layer = root?.querySelector<SVGSVGElement>(
        '[data-card-liquid-layer]',
      );
      if (
        !root ||
        !layer ||
        disabled ||
        !regrouping(patch) ||
        window.matchMedia('(prefers-reduced-motion: reduce)').matches
      )
        return noop;
      try {
        const before = captureCards(root, layer, patch.before);
        if (!before) return noop;
        // Flip measures each target's transform with temporary DOM writes. Keep
        // that work inside the clipped presentation; piece surfaces still use
        // the complete bounds above, including members that become visible.
        const targets = [...before.values()].flatMap((card) =>
          [...card.assets.values()]
            .filter((asset) => asset.visible)
            .map((asset) => asset.element),
        );
        // Capture the presentation state before cancelling an interrupted undo/redo.
        // GSAP supports kill:false; its bundled FlipStateVars omits this option.
        const options: Flip.FlipStateVars & { kill: boolean } = { kill: false };
        const state = Flip.getState(targets, options);
        cancel();
        let accepted = false;
        let stopped = false;
        let stopAnimation = noop;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          stopped = true;
          observer.disconnect();
          clearTimeout(timer);
          stopAnimation();
        };
        const play = () => {
          if (!accepted || stopped) return;
          const after = captureCards(root, layer, patch.after);
          if (!after) return;
          observer.disconnect();
          clearTimeout(timer);
          try {
            stopAnimation = animateRegroup(
              root,
              layer,
              patch,
              before,
              after,
              state,
              cancel,
            );
          } catch (error) {
            console.warn('Card transition skipped:', error);
            cancel();
          }
        };
        const observer = new MutationObserver(play);
        observer.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-card-assets', 'style'],
        });
        active.current = cleanup;
        return (saved) => {
          if (stopped) return;
          if (!saved) {
            cancel();
            return;
          }
          accepted = true;
          // An unavailable/unmounted target must never leave an observer behind.
          timer = setTimeout(cancel, 1000);
          play();
        };
      } catch (error) {
        console.warn('Card transition skipped:', error);
        cancel();
        return noop;
      }
    },
    [rootRef, disabled, cancel],
  );
}
