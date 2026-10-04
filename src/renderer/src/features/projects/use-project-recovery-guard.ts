import { useLayoutEffect, useRef } from 'react';
import type { Asset, ProjectSnapshot } from '../../../../shared/models';
import { projectRecoveryGuards } from './project-recovery-guards';

export function useProjectRecoveryGuard(
  projectId: string,
  guard: (
    snapshot: ProjectSnapshot,
    savedReferenceAssets?: Asset[],
  ) => Promise<string | null> | string | null,
) {
  const latest = useRef(guard);
  latest.current = guard;
  useLayoutEffect(
    () =>
      projectRecoveryGuards.register(
        projectId,
        (snapshot, savedReferenceAssets) =>
          latest.current(snapshot, savedReferenceAssets),
      ),
    [projectId],
  );
}
