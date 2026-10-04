import {
  type BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
} from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import { isId } from '../projects/project-service';
import type { Library } from '../storage/library';

export function registerRecoveryIpc(
  library: Library,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
  getWindow: () => BrowserWindow | null,
) {
  let selecting = false;
  const id = (value: unknown) => {
    if (!isId(value)) throw new Error('无效的项目或素材标识');
    return value;
  };
  ipcMain.handle(
    IPC_CHANNELS.scanProjectHealth,
    (event, projectId: unknown, mode: unknown) => {
      trustedWindow(event);
      if (mode !== 'quick' && mode !== 'full')
        throw new Error('无效的素材检查模式');
      return library.health.scan(id(projectId), mode);
    },
  );
  ipcMain.handle(IPC_CHANNELS.cancelProjectHealth, (event) => {
    trustedWindow(event);
    library.health.cancel();
  });
  ipcMain.handle(
    IPC_CHANNELS.restoreMissingAsset,
    async (event, projectId: unknown, assetId: unknown) => {
      const window = trustedWindow(event);
      const project = id(projectId);
      const asset = id(assetId);
      library.projects.summary(project);
      if (selecting) throw new Error('请先完成或取消当前文件选择');
      const epoch = library.health.cancellationVersion;
      selecting = true;
      let choice: Electron.OpenDialogReturnValue;
      try {
        choice = await dialog.showOpenDialog(window, {
          title: '选择内容完全相同的原素材',
          buttonLabel: '验证并恢复',
          properties: ['openFile'],
        });
      } finally {
        selecting = false;
      }
      if (library.health.cancellationVersion !== epoch) return null;
      if (choice.canceled || !choice.filePaths[0]) return null;
      trustedWindow(event);
      const report = await library.health.restore(
        project,
        asset,
        choice.filePaths[0],
      );
      library.emit();
      return report;
    },
  );
  library.health.subscribe((progress) => {
    const window = getWindow();
    if (window && !window.isDestroyed())
      window.webContents.send(IPC_CHANNELS.projectHealthProgress, progress);
  });
}
