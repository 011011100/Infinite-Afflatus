import type { AppBackupInfo } from '../../src/shared/app-backup';
import type { DesktopBridge } from '../../src/shared/desktop';

/** Small in-memory semantics for fixtures whose focus is another settings panel. */
export function appBackupMock(): Pick<
  DesktopBridge,
  | 'getAppBackups'
  | 'createAppBackup'
  | 'revealAppBackups'
  | 'revealRetainedAppData'
> {
  const backups: AppBackupInfo[] = [];
  return {
    getAppBackups: async () => ({
      directory: '/fixture/application-data/app-backups',
      backups: structuredClone(backups),
      issues: [],
      recovery: null,
    }),
    createAppBackup: async () => {
      const backup: AppBackupInfo = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        appVersion: '0.1.0',
        root: '/fixture/projects',
        projectCount: 0,
        saveCount: 0,
        bytes: 4096,
        sha256: 'a'.repeat(64),
        restorable: true,
        reason: null,
      };
      backups.unshift(backup);
      return structuredClone(backup);
    },
    revealAppBackups: async () => {},
    revealRetainedAppData: async () => {},
  };
}
