/** Ephemeral progress for one local selection; never a persisted generation task. */
export interface ReferenceImportProgress {
  requestId: string;
  projectId: string;
  phase:
    | 'choosing'
    | 'receiving'
    | 'finalizing'
    | 'cancelling'
    | 'completed'
    | 'cancelled';
  /** One-based while processing a file, zero before a selection is available. */
  fileIndex: number;
  totalFiles: number;
  fileName: string | null;
  /** Bytes actually written for the current file, not a time-based estimate. */
  receivedBytes: number;
  fileBytes: number | null;
  acceptedCount: number;
  failedCount: number;
}
