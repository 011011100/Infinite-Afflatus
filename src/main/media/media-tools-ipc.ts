import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import { MediaToolDiagnostics } from './media-tool-diagnostics';

export function registerMediaToolsIpc(
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  const diagnostics = new MediaToolDiagnostics();
  ipcMain.handle(IPC_CHANNELS.checkMediaTools, (event) => {
    trustedWindow(event);
    return diagnostics.check();
  });
}
