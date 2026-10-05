import type { DesktopBridge } from '../../src/shared/desktop';

/** Fixtures without package work still model independent native leave leases. */
export function projectPackageMock(prepare?: () => void) {
  const pauses = new Set<string>();
  const bridge: Pick<
    DesktopBridge,
    | 'onProjectPackageProgress'
    | 'preparePackageOperationsForLeave'
    | 'resumePackageOperations'
  > = {
    onProjectPackageProgress: () => () => {},
    preparePackageOperationsForLeave: async () => {
      const token = crypto.randomUUID();
      pauses.add(token);
      prepare?.();
      return token;
    },
    resumePackageOperations: async (token) => {
      pauses.delete(token);
    },
  };
  return { bridge, pauses };
}
