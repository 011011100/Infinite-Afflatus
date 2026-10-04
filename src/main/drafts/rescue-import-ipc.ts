import {
  type BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
} from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import { draftId } from './draft-validation';
import type { RescueImportService } from './rescue-import-service';

/** File paths come only from a trusted native chooser; confirmation uses an opaque ticket. */
export function registerRescueImportIpc(
  imports: Pick<RescueImportService, 'prepare' | 'confirm' | 'clear'>,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  let selecting = false;
  const epochs = new Map<number, number>();
  const watched = new WeakSet<BrowserWindow>();
  const cancel = (owner: number) => {
    epochs.set(owner, (epochs.get(owner) ?? 0) + 1);
    imports.clear(owner);
  };
  const ownerFor = (event: IpcMainInvokeEvent) => {
    const window = trustedWindow(event);
    const owner = window.webContents.id;
    if (!watched.has(window)) {
      watched.add(window);
      window.once('closed', () => {
        cancel(owner);
        epochs.delete(owner);
      });
    }
    return { window, owner };
  };
  ipcMain.handle(IPC_CHANNELS.chooseRescueImport, async (event) => {
    const { window, owner } = ownerFor(event);
    if (selecting) throw new Error('请先完成或取消当前文件选择');
    cancel(owner);
    const epoch = epochs.get(owner);
    selecting = true;
    try {
      const choice = await dialog.showOpenDialog(window, {
        title: '导入恢复文件',
        buttonLabel: '检查恢复文件',
        properties: ['openFile'],
        filters: [{ name: '镜头、名称或裁剪恢复文件', extensions: ['json'] }],
      });
      if (
        choice.canceled ||
        !choice.filePaths[0] ||
        window.isDestroyed() ||
        epochs.get(owner) !== epoch
      )
        return null;
      if (trustedWindow(event) !== window)
        throw new Error('导入窗口已变化，请重新选择恢复文件');
      if (choice.filePaths.length !== 1)
        throw new Error('请一次选择一个恢复文件');
      const preview = await imports.prepare(choice.filePaths[0], owner);
      if (window.isDestroyed() || epochs.get(owner) !== epoch) return null;
      if (trustedWindow(event) !== window)
        throw new Error('导入窗口已变化，请重新选择恢复文件');
      return preview;
    } finally {
      selecting = false;
    }
  });
  ipcMain.handle(IPC_CHANNELS.confirmRescueImport, (event, token: unknown) => {
    const { owner } = ownerFor(event);
    return imports.confirm(draftId(token), owner);
  });
  ipcMain.handle(IPC_CHANNELS.cancelRescueImport, (event) => {
    const { owner } = ownerFor(event);
    cancel(owner);
  });
}
