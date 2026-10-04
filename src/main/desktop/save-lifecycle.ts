import { type BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import type { ReferenceImportService } from '../generation/reference-import-service';
import { SaveRequest } from './save-request';

export class SaveLifecycle {
  private preparation: {
    window: BrowserWindow;
    ready: Promise<string | null>;
    result: Promise<boolean>;
  } | null = null;
  private readonly closedOwners = new Set<number>();
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
    private readonly referenceImports?: Pick<
      ReferenceImportService,
      'prepareForLeave' | 'resumeAfterLeave' | 'resumeOwner'
    >,
  ) {
    ipcMain.handle(
      IPC_CHANNELS.saveBeforeLeaveResult,
      async (event, token, saved) => {
        const window = this.getWindow();
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame
        )
          throw new Error('Untrusted save acknowledgement');
        let confirmed = saved;
        if (saved === true && this.preparation?.window === window) {
          try {
            // Keep the native request's timeout running while native cleanup
            // completes, even if the renderer acknowledges prematurely.
            await this.preparation.ready;
          } catch {
            confirmed = false;
            window.webContents.send(IPC_CHANNELS.leaveCancelled);
          }
        }
        this.requests.acknowledge(window, token, confirmed);
        if (!confirmed) {
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
    if (this.preparation?.window === window) return this.preparation.result;
    const owner = window.webContents.id;
    const attempt = {
      window,
      ready:
        this.referenceImports?.prepareForLeave(owner) ?? Promise.resolve(null),
      result: Promise.resolve(false),
    };
    this.preparation = attempt;
    // Observe failures even when an unresponsive renderer never acknowledges.
    void attempt.ready.catch((error: unknown) => {
      console.warn('Reference import leave preparation failed:', error);
    });
    attempt.result = this.requests.request(window).then((saved) => {
      if (!saved) {
        // A timeout returns promptly. Release this lease when cleanup finishes;
        // it must never unlock a later attempt's independent lease.
        void attempt.ready
          .then((token) => {
            if (token) this.referenceImports?.resumeAfterLeave(owner, token);
          })
          .catch(() => undefined);
      }
      if (this.preparation === attempt) this.preparation = null;
      return saved;
    });
    return attempt.result;
  }

  protect(window: BrowserWindow, isQuitting: () => boolean): void {
    // macOS can keep the application alive after its only window was closed.
    // Reopening releases leases belonging only to those destroyed windows.
    for (const owner of this.closedOwners)
      this.referenceImports?.resumeOwner(owner);
    this.closedOwners.clear();
    const owner = window.webContents.id;
    window.once('closed', () => this.closedOwners.add(owner));
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
