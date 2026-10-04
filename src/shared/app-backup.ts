/** A local application database checkpoint; project media and staging bytes stay in place. */
export interface AppBackupInfo {
  id: string;
  createdAt: string;
  appVersion: string;
  root: string;
  projectCount: number;
  saveCount: number;
  bytes: number;
  sha256: string;
  restorable: boolean;
  reason: string | null;
}

export interface AppBackupRecoveryReport {
  restoredAt: string;
  backupId: string;
  retainedDirectory: string;
  retainedJobCount: number;
  retainedFileCount: number;
  warning: string;
}

export interface AppBackupList {
  directory: string;
  backups: AppBackupInfo[];
  issues: { file: string; message: string }[];
  recovery: AppBackupRecoveryReport | null;
}

/** Main-process only confirmation data. Restoring is never exposed to a running renderer. */
export interface AppBackupRestorePreview {
  token: string;
  expiresAt: string;
  backup: AppBackupInfo;
  projectCount: number;
  retainedJobCount: number;
  retainedFileCount: number;
  warnings: string[];
}

export interface AppBackupRestoreResult {
  backupId: string;
  retainedDirectory: string;
  report: AppBackupRecoveryReport;
}
