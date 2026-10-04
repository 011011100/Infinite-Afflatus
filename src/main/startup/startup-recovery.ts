export type StartupRecoveryAction =
  | 'retry'
  | 'show-data'
  | 'show-projects'
  | 'restore-backup'
  | 'quit';

/** Location viewing never opens storage; retry or a confirmed restore starts the next open. */
export async function runStartupRecovery<T>(
  open: () => Promise<T>,
  choose: (
    failure: unknown,
    locationError: string | null,
  ) => Promise<StartupRecoveryAction>,
  reveal: (
    action: 'show-data' | 'show-projects',
    failure: unknown,
  ) => Promise<void>,
  restoreBackup?: () => Promise<boolean>,
): Promise<T | null> {
  for (;;) {
    try {
      return await open();
    } catch (failure) {
      let locationError: string | null = null;
      for (;;) {
        const action = await choose(failure, locationError);
        if (action === 'quit') return null;
        if (action === 'retry') break;
        try {
          if (action === 'restore-backup') {
            if (!restoreBackup) throw new Error('当前版本未提供备份恢复');
            if (await restoreBackup()) break;
            locationError = null;
            continue;
          }
          await reveal(action, failure);
          locationError = null;
        } catch (error) {
          locationError = `${action === 'restore-backup' ? '备份恢复未完成' : '无法打开该位置'}：${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
  }
}
