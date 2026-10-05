/** Portable editable-project archive, distinct from an exported video. */
export interface ProjectPackageInfo {
  projectId: string;
  name: string;
  assetCount: number;
  /** Estimated uncompressed database and managed-media bytes. */
  bytes: number;
}

export interface ProjectPackageExport extends ProjectPackageInfo {
  path: string;
}

export type ProjectPackageOperation =
  | 'inspect'
  | 'export'
  | 'import'
  | 'duplicate';
export type ProjectPackagePhase =
  | 'choosing'
  | 'waiting'
  | 'preparing'
  | 'copying'
  | 'verifying'
  | 'finalizing'
  | 'cancelling'
  | 'completed'
  | 'cancelled'
  | 'failed';

/** Ephemeral operation progress. Bytes count successfully written archive payload only. */
export interface ProjectPackageProgress {
  requestId: string;
  projectId: string | null;
  operation: ProjectPackageOperation;
  phase: ProjectPackagePhase;
  completedBytes: number;
  totalBytes: number | null;
  completedFiles: number;
  totalFiles: number | null;
  fileName: string | null;
  canCancel: boolean;
}
