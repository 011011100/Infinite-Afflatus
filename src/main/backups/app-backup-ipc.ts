import {
  type BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  shell,
} from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import type { AppBackupService } from './app-backup-service';

/** Only fixed, verified backup locations cross this boundary; restore is startup-only. */
export function registerAppBackupIpc(
  backups: Pick<
    AppBackupService,
    'list' | 'create' | 'backupDirectory' | 'retainedDirectory'
  >,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(IPC_CHANNELS.getAppBackups, (event) => {
    trustedWindow(event);
    return backups.list();
  });
  ipcMain.handle(IPC_CHANNELS.createAppBackup, (event) => {
    trustedWindow(event);
    return backups.create();
  });
  const reveal = async (event: IpcMainInvokeEvent, retained: boolean) => {
    const window = trustedWindow(event);
    const path = retained
      ? await backups.retainedDirectory()
      : await backups.backupDirectory();
    if (trustedWindow(event) !== window)
      throw new Error('备份设置窗口已变化，请重新打开位置');
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  };
  ipcMain.handle(IPC_CHANNELS.revealAppBackups, (event) =>
    reveal(event, false),
  );
  ipcMain.handle(IPC_CHANNELS.revealRetainedAppData, (event) =>
    reveal(event, true),
  );
}
