import { useLayoutEffect, useRef } from 'react';
import { pendingSaves } from './pending-saves';

export function usePendingSave(
  label: string,
  flush: () => Promise<boolean>,
  priority = 0,
) {
  const latest = useRef(flush);
  latest.current = flush;
  useLayoutEffect(
    () => pendingSaves.register(label, () => latest.current(), priority),
    [label, priority],
  );
}
