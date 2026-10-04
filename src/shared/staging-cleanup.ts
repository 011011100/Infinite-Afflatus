/** Read-only classification of failed save jobs, based on their current staging files. */
export interface StagingItem {
  jobId: string;
  name: string;
  category: 'incomplete-local' | 'save-failed' | 'retained-result';
  cancelled: boolean;
  bytes: number | null;
  canRetry: boolean;
  canCleanup: boolean;
  reason: string;
}

export interface StagingInspection {
  items: StagingItem[];
}

export interface StagingCleanupFile {
  jobId: string;
  name: string;
  bytes: number;
}

export interface StagingCleanupPreview {
  /** Null when there are no files that can be safely removed. */
  token: string | null;
  expiresAt: string | null;
  files: StagingCleanupFile[];
  bytes: number;
  retained: StagingItem[];
}

export interface StagingCleanupResult {
  removedCount: number;
  removedBytes: number;
  retained: { jobId: string; name: string; reason: string }[];
}
