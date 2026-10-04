import type { Asset, ProjectSnapshot } from './models';

/** One main-process read, without a save queue commit between these two views. */
export interface ProjectRecoverySnapshot {
  snapshot: ProjectSnapshot;
  savedReferenceAssets: Asset[];
}
