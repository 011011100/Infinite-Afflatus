export type StartupRecoveryAction =
  | 'retry'
  | 'show-data'
  | 'show-projects'
  | 'restore-backup'
  | 'relocate-root'
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
  relocateRoot?: () => Promise<boolean>,
  signal?: AbortSignal,
): Promise<T | null> {
  for (;;) {
    if (signal?.aborted) return null;
    try {
      return await open();
    } catch (failure) {
      let locationError: string | null = null;
      for (;;) {
        if (signal?.aborted) return null;
        let action: StartupRecoveryAction;
        try {
          action = await choose(failure, locationError);
        } catch (error) {
          if (signal?.aborted) return null;
          throw error;
        }
        if (signal?.aborted) return null;
        if (action === 'quit') return null;
        if (action === 'retry') break;
        try {
          if (action === 'restore-backup') {
            if (!restoreBackup) throw new Error('当前版本未提供备份恢复');
            if (await restoreBackup()) break;
            locationError = null;
            continue;
          }
          if (action === 'relocate-root') {
            if (!relocateRoot) throw new Error('当前版本未提供原目录重新定位');
            if (await relocateRoot()) break;
            locationError = null;
            continue;
          }
          await reveal(action, failure);
          locationError = null;
        } catch (error) {
          const operation =
            action === 'restore-backup'
              ? '备份恢复未完成'
              : action === 'relocate-root'
                ? '原目录重新定位未完成'
                : '无法打开该位置';
          locationError = `${operation}：${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }
  }
}
