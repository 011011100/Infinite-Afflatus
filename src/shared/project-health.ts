import type { Asset } from './models';

export type ProjectHealthMode = 'quick' | 'full';
export interface ProjectAssetIssue {
  assetId: string;
  name: string;
  kind: Asset['kind'];
  relativePath: string;
  problem: 'missing' | 'changed' | 'unreadable' | 'unsafe';
  message: string;
}
export interface ProjectHealthReport {
  projectId: string;
  mode: ProjectHealthMode;
  checkedAt: string;
  assetCount: number;
  issues: ProjectAssetIssue[];
}
export interface ProjectHealthProgress {
  projectId: string;
  operation: 'scan' | 'restore';
  progress: number;
  assetName: string | null;
}
