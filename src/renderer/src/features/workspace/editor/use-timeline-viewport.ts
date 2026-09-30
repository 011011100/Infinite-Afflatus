import { useLayoutEffect, useRef, useState } from 'react';
import { boundScroll, timelineLayout } from './timeline-layout';

export interface TrimScrollReserve {
  before: number;
  after: number;
}

/** Keep a session-local coordinate origin, separate from source-media timestamps. */
export function useTimelineViewport(
  duration: number,
  trimOrigin: number,
  zoom: number,
) {
  const scroll = useRef<HTMLDivElement>(null);
  const initialDuration = useRef(duration);
  const base = useRef(trimOrigin);
  const heldBase = useRef<number | null>(null);
  const previous = useRef<{
    base: number;
    scale: number;
    origin: number;
  } | null>(null);
  const [viewport, setViewport] = useState(900);
  const [visibleLeft, setVisibleLeft] = useState(0);
  const [heldWidth, setHeldWidth] = useState<number | null>(null);
  base.current = Math.min(base.current, trimOrigin);
  const origin = trimOrigin - base.current;
  const layout = timelineLayout(
    viewport,
    initialDuration.current,
    zoom,
    origin,
    duration,
    heldWidth ?? 0,
  );

  useLayoutEffect(() => {
    if (heldWidth !== null && layout.width > heldWidth)
      setHeldWidth(layout.width);
  }, [heldWidth, layout.width]);

  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const measure = () => setViewport(Math.max(1, element.clientWidth - 64));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const constrainScroll = () => {
    const element = scroll.current;
    if (!element) return;
    const bounded =
      heldWidth !== null
        ? element.scrollLeft
        : boundScroll(element.scrollLeft, layout.minScroll, layout.maxScroll);
    if (Math.abs(element.scrollLeft - bounded) > 0.5)
      element.scrollLeft = bounded;
    setVisibleLeft(element.scrollLeft);
  };
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const last = previous.current;
    if (last) {
      if (last.scale !== layout.scale) {
        const timeAtLeft = element.scrollLeft / last.scale - last.origin;
        element.scrollLeft = (origin + timeAtLeft) * layout.scale;
      } else if (last.base !== base.current) {
        // Revealing an earlier source in-point must not move the opposite edge.
        element.scrollLeft += (last.base - base.current) * layout.scale;
      }
    }
    previous.current = { base: base.current, scale: layout.scale, origin };
    if (heldWidth === null)
      element.scrollLeft = boundScroll(
        element.scrollLeft,
        layout.minScroll,
        layout.maxScroll,
      );
    setVisibleLeft(element.scrollLeft);
  }, [origin, layout.scale, layout.minScroll, layout.maxScroll, heldWidth]);

  const reveal = (time: number) => {
    const element = scroll.current;
    if (!element || heldWidth !== null) return;
    const x = (origin + time) * layout.scale;
    if (x < element.scrollLeft || x > element.scrollLeft + viewport)
      element.scrollLeft = boundScroll(
        x - viewport / 2,
        layout.minScroll,
        layout.maxScroll,
      );
  };
  return {
    scroll,
    origin,
    scale: layout.scale,
    trackWidth: layout.width,
    visibleLeft,
    visibleWidth: viewport,
    constrainScroll,
    reveal,
    // Rebasing adds matching pixels to scrollLeft. It must not count as a drag.
    position: () =>
      (scroll.current?.scrollLeft ?? 0) +
      (previous.current?.base ?? base.current) * layout.scale,
    bounds: () => scroll.current?.getBoundingClientRect(),
    panBy: (delta: number) => {
      const element = scroll.current;
      if (element)
        element.scrollLeft = boundScroll(
          element.scrollLeft + delta,
          0,
          layout.maxScroll,
        );
    },
    hold: (active: boolean, reserve?: TrimScrollReserve, cancelled = false) => {
      if (active) {
        heldBase.current = base.current;
        base.current -= reserve?.before ?? 0;
        setHeldWidth(
          layout.width +
            ((reserve?.before ?? 0) + (reserve?.after ?? 0)) * layout.scale,
        );
      } else {
        if (heldBase.current !== null)
          base.current = cancelled
            ? heldBase.current
            : Math.min(heldBase.current, trimOrigin);
        heldBase.current = null;
        setHeldWidth(null);
      }
    },
  };
}
