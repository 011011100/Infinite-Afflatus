import type { DesktopBridge } from '../../src/shared/desktop';

/** Independent pause tokens, matching the lifetime of a real leave request. */
export function referenceImportMock() {
  const pauses = new Set<string>();
  const bridge: Pick<
    DesktopBridge,
    | 'importReferences'
    | 'onReferenceImportProgress'
    | 'cancelReferenceImport'
    | 'prepareReferenceImportsForLeave'
    | 'resumeReferenceSaves'
    | 'cancelStagingOperations'
  > = {
    importReferences: async () => ({
      assetIds: [],
      errors: [],
      cancelled: true,
      cancelledCount: 0,
    }),
    onReferenceImportProgress: () => () => {},
    cancelReferenceImport: async () => {},
    cancelStagingOperations: async () => {},
    prepareReferenceImportsForLeave: async () => {
      const token = crypto.randomUUID();
      pauses.add(token);
      return token;
    },
    resumeReferenceSaves: async (token) => {
      pauses.delete(token);
    },
  };
  return { bridge, pauses };
}
