export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  folder: string;
  updatedAt: string;
}

export interface Asset {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  sha256: string;
  kind: 'video' | 'image';
}

export interface ProjectSnapshot {
  project: ProjectSummary;
  viewport: Viewport;
  assets: Asset[];
}

export type SaveStatus = 'receiving' | 'ready' | 'saving' | 'saved' | 'failed';

export interface SaveJob {
  id: string;
  projectId: string;
  resultKey: string;
  name: string;
  kind: Asset['kind'];
  extension: string;
  status: SaveStatus;
  size: number;
  sha256: string;
  error: string | null;
  createdAt: string;
  outputRelativePath?: string;
}

export type MigrationPhase =
  | 'copying'
  | 'verifying'
  | 'cleaning'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface MigrationStatus {
  id: string;
  source: string;
  target: string;
  phase: MigrationPhase;
  copied: number;
  total: number;
  error: string | null;
  warnings: string[];
}

export interface LibraryState {
  root: string;
  projects: ProjectSummary[];
  jobs: SaveJob[];
  migration: MigrationStatus | null;
  writeBlocked: boolean;
}

export interface MigrationPreview {
  token: string;
  source: string;
  target: string;
  projectCount: number;
  bytes: number;
}
