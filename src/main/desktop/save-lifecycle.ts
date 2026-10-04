import { type BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import { SaveRequest } from './save-request';

export class SaveLifecycle {
  private readonly requests = new SaveRequest<BrowserWindow>(
    (window, token) =>
      window.webContents.send(IPC_CHANNELS.saveBeforeLeave, token),
    (window) => {
      if (window.isDestroyed()) return;
      window.webContents.send(IPC_CHANNELS.leaveCancelled);
      window.show();
      dialog.showErrorBox(
        '未关闭应用',
        '编辑页面尚未确认保存，窗口已保留。请等待页面恢复后重试关闭。',
      );
    },
  );

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly beforeSave: () => void = () => {},
  ) {
    ipcMain.handle(
      IPC_CHANNELS.saveBeforeLeaveResult,
      (event, token, saved) => {
        const window = this.getWindow();
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          throw new Error('Untrusted save acknowledgement');
        this.requests.acknowledge(window, token, saved);
        if (!saved) {
          window.show();
          window.focus();
        }
      },
    );
  }

  prepare(): Promise<boolean> {
    // Package copies hold the write gate. Cancel them before renderer drafts
    // queue for that gate, otherwise quitting could wait behind a huge backup.
    this.beforeSave();
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return Promise.resolve(true);
    return this.requests.request(window);
  }

  protect(window: BrowserWindow, isQuitting: () => boolean): void {
    let closing = false;
    window.on('close', (event) => {
      event.preventDefault();
      if (closing || isQuitting()) return;
      closing = true;
      void this.prepare().then((saved) => {
        closing = false;
        if (saved && !isQuitting() && !window.isDestroyed()) window.destroy();
      });
    });
  }
}
