import { type BrowserWindow, dialog, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import type { ReferenceImportService } from '../generation/reference-import-service';
import { SaveRequest } from './save-request';

type LeaveOperations = Pick<
  ReferenceImportService,
  'prepareForLeave' | 'resumeAfterLeave' | 'resumeOwner'
>;
type LeaveTokens = { references: string | null; packages: string | null };

export class SaveLifecycle {
  private preparation: {
    window: BrowserWindow;
    ready: Promise<LeaveTokens>;
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
    private readonly referenceImports?: LeaveOperations,
    private readonly packageRequests?: LeaveOperations,
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
      ready: this.prepareOperations(owner),
      result: Promise.resolve(false),
    };
    this.preparation = attempt;
    // Observe failures even when an unresponsive renderer never acknowledges.
    void attempt.ready.catch((error: unknown) => {
      console.warn('File operation leave preparation failed:', error);
    });
    attempt.result = this.requests.request(window).then((saved) => {
      if (!saved) {
        // A timeout returns promptly. Release this lease when cleanup finishes;
        // it must never unlock a later attempt's independent lease.
        void attempt.ready
          .then((tokens) => this.resumeOperations(owner, tokens))
          .catch(() => undefined);
      }
      if (this.preparation === attempt) this.preparation = null;
      return saved;
    });
    return attempt.result;
  }

  private async prepareOperations(owner: number): Promise<LeaveTokens> {
    // Both kinds stop admission before either is awaited. A failed preparation
    // still waits for the other cleanup, then releases only this attempt's lease.
    const results = await Promise.allSettled([
      this.referenceImports?.prepareForLeave(owner) ?? Promise.resolve(null),
      this.packageRequests?.prepareForLeave(owner) ?? Promise.resolve(null),
    ]);
    const tokens: LeaveTokens = {
      references: results[0].status === 'fulfilled' ? results[0].value : null,
      packages: results[1].status === 'fulfilled' ? results[1].value : null,
    };
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length) {
      try {
        this.resumeOperations(owner, tokens);
      } catch (error) {
        errors.push(error);
      }
      throw new AggregateError(errors, '文件操作未能安全停止');
    }
    return tokens;
  }

  private resumeOperations(owner: number, tokens: LeaveTokens): void {
    const errors: unknown[] = [];
    for (const [service, token] of [
      [this.referenceImports, tokens.references],
      [this.packageRequests, tokens.packages],
    ] as const) {
      try {
        if (token) service?.resumeAfterLeave(owner, token);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, '未能恢复文件操作');
  }

  protect(window: BrowserWindow, isQuitting: () => boolean): void {
    // macOS can keep the application alive after its only window was closed.
    // Reopening releases leases belonging only to those destroyed windows.
    for (const owner of this.closedOwners) {
      this.referenceImports?.resumeOwner(owner);
      this.packageRequests?.resumeOwner(owner);
    }
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
