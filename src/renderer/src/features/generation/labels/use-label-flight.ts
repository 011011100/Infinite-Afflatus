import type { ReactFlowInstance } from '@xyflow/react';
import { type RefObject, useCallback, useEffect, useRef } from 'react';
import type { CanvasLabel } from '../../../../../shared/generation/workspace';
import type { Viewport } from '../../../../../shared/models';
import type { MaterialCanvasNode } from '../use-material-flow';
import { labelFlight } from './geometry';

/** Own the camera clock so pointer/wheel input can stop every phase immediately. */
export function useLabelFlight(
  flow: RefObject<ReactFlowInstance<MaterialCanvasNode> | null>,
  area: RefObject<HTMLDivElement | null>,
  save: (view: Viewport) => void,
) {
  const frame = useRef(0);
  const moving = useRef(false);
  const saveRef = useRef(save);
  saveRef.current = save;
  const cancel = useCallback(() => {
    cancelAnimationFrame(frame.current);
    if (moving.current && flow.current)
      saveRef.current(flow.current.getViewport());
    moving.current = false;
  }, [flow]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const jump = (label: CanvasLabel) => {
    cancel();
    const instance = flow.current,
      container = area.current;
    if (!instance || !container) return;
    const steps = labelFlight(
      instance.getViewport(),
      label,
      container.getBoundingClientRect(),
    );
    const final = steps[2];
    if (!final) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      void instance.setViewport(final);
      saveRef.current(final);
      return;
    }
    moving.current = true;
    let phase = 0,
      start = performance.now(),
      from = instance.getViewport();
    const durations = [180, 320, 220];
    const tick = (now: number) => {
      const to = steps[phase];
      if (!to || !moving.current) return;
      const t = Math.min(1, (now - start) / (durations[phase] ?? 220));
      const eased = t * t * (3 - 2 * t);
      void instance.setViewport({
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
        zoom: from.zoom + (to.zoom - from.zoom) * eased,
      });
      if (t === 1) {
        phase++;
        start = now;
        from = to;
        if (phase === steps.length) {
          moving.current = false;
          saveRef.current(final);
          return;
        }
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  };
  return { moving, cancel, jump };
}
