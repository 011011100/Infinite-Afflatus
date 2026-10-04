import type { ProjectSummary } from '../../shared/models';
import type { BackupAnchor } from '../backups/backup-anchor';
import type { DirectoryIdentity, FileIdentity } from '../backups/backup-files';

export const RELOCATION_FILE = 'app-root-relocation.json';
export const RELOCATION_DIRECTORY = 'app-root-relocation-retained';

export interface RootRelocationPreview {
  token: string;
  expiresAt: string;
  oldRoot: string;
  newRoot: string;
  projects: { id: string; name: string }[];
  pendingSaveCount: number;
}
export interface RootRelocationResult {
  root: string;
  retainedDirectory: string;
}
/** ctime is checked within each read, but excluded here: our own link/rename changes it. */
export interface DatabaseEvidence extends FileIdentity {
  size: string;
  mtimeNs: string;
  sha256: string;
}
export interface ProjectEvidence {
  project: ProjectSummary;
  directory: DirectoryIdentity;
  database: DatabaseEvidence;
}
export interface RelocationInspection {
  anchor: BackupAnchor;
  original: DatabaseEvidence;
  root: DirectoryIdentity;
  projects: ProjectEvidence[];
  pendingSaveCount: number;
}
/** Immutable intent: on-disk identities distinguish all four publication states. */
export interface RelocationIntent {
  format: 'infinite-afflatus-root-relocation';
  version: 1;
  id: string;
  anchor: BackupAnchor;
  resultAnchor: BackupAnchor;
  original: DatabaseEvidence;
  candidate: DatabaseEvidence;
  projects: ProjectEvidence[];
  retained: DirectoryIdentity;
}
