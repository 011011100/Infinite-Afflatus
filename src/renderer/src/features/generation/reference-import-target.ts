import type { Point } from '../../../../shared/generation/workspace';

export type ImportedReferenceNode = {
  id: string;
  assetId: string;
  position: Point;
};

/** Only references from an already-started local intake may finish through a write lock. */
export interface ReferenceImportTarget {
  append(nodes: readonly ImportedReferenceNode[]): boolean;
  finish(): void;
}
