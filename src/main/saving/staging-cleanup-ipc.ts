import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import type { StagingCleanupService } from './staging-cleanup-service';

export function registerStagingCleanupIpc(
  service: Pick<
    StagingCleanupService,
    'inspect' | 'preview' | 'execute' | 'cancel'
  >,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
): void {
  const owners = new Map<string, number>();
  ipcMain.handle(IPC_CHANNELS.inspectStaging, (event) => {
    trustedWindow(event);
    return service.inspect();
  });
  ipcMain.handle(IPC_CHANNELS.previewStagingCleanup, async (event) => {
    const owner = trustedWindow(event).webContents.id;
    const preview = await service.preview();
    // A closed or replaced window cannot hand a destructive confirmation to its successor.
    if (trustedWindow(event).webContents.id !== owner)
      throw new Error('原窗口已关闭，请重新检查未完成导入');
    owners.clear();
    if (preview.token) owners.set(preview.token, owner);
    return preview;
  });
  ipcMain.handle(
    IPC_CHANNELS.executeStagingCleanup,
    (event, token: unknown) => {
      const owner = trustedWindow(event).webContents.id;
      if (
        typeof token !== 'string' ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(token) ||
        owners.get(token) !== owner
      )
        throw new Error('清理预览已失效，请重新检查未完成导入');
      owners.delete(token);
      return service.execute(token);
    },
  );
  ipcMain.handle(IPC_CHANNELS.cancelStagingOperations, (event) => {
    trustedWindow(event);
    owners.clear();
    service.cancel();
  });
}
