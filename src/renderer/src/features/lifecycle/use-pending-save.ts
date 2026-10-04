import { useLayoutEffect, useRef } from 'react';
import { pendingSaves } from './pending-saves';

export function usePendingSave(
  label: string,
  flush: () => Promise<boolean>,
  priority = 0,
  capturePending?: () => Promise<boolean> | null,
) {
  const latest = useRef(flush);
  latest.current = flush;
  const capture = useRef(capturePending);
  capture.current = capturePending;
  useLayoutEffect(
    () =>
      pendingSaves.register(
        label,
        () => latest.current(),
        priority,
        () => capture.current?.() ?? null,
      ),
    [label, priority],
  );
}
