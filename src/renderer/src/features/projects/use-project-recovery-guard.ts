import { useLayoutEffect, useRef } from 'react';
import type { ProjectSnapshot } from '../../../../shared/models';
import { projectRecoveryGuards } from './project-recovery-guards';

export function useProjectRecoveryGuard(
  projectId: string,
  guard: (snapshot: ProjectSnapshot) => Promise<string | null> | string | null,
) {
  const latest = useRef(guard);
  latest.current = guard;
  useLayoutEffect(
    () =>
      projectRecoveryGuards.register(projectId, (snapshot) =>
        latest.current(snapshot),
      ),
    [projectId],
  );
}
