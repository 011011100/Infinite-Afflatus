/** Only registered derived previews can be candidates; unknown entries are retained. */
export interface PreviewCacheItem {
  projectId: string;
  projectName: string;
  relativePath: string;
  assetId: string | null;
  kind: 'proxy' | 'unknown';
  /** Actual observed regular-file bytes, never the database's advertised size. */
  bytes: number | null;
  canCleanup: boolean;
  reason: string;
}

export interface PreviewCacheInspection {
  items: PreviewCacheItem[];
  bytes: number;
  eligibleCount: number;
  eligibleBytes: number;
  /** Some entries could not be measured without following unsafe paths. */
  incomplete: boolean;
}

export interface PreviewCacheCleanupPreview {
  token: string | null;
  expiresAt: string | null;
  files: PreviewCacheItem[];
  bytes: number;
  retained: PreviewCacheItem[];
  incomplete: boolean;
}

export interface PreviewCacheCleanupResult {
  removedCount: number;
  removedBytes: number;
  retained: PreviewCacheItem[];
  cancelled: boolean;
}
