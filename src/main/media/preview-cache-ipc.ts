import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import type { PreviewCacheService } from './preview-cache-service';

/** A renderer may confirm only its latest, still-visible inspection. */
export function registerPreviewCacheIpc(
  service: Pick<
    PreviewCacheService,
    'inspect' | 'preview' | 'execute' | 'cancel'
  >,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
): void {
  let revision = 0;
  let owner: number | null = null;
  let token: string | null = null;
  const watched = new Set<number>();
  const invalidate = () => {
    revision += 1;
    token = null;
    owner = null;
    service.cancel();
  };
  const windowFor = (event: IpcMainInvokeEvent) => {
    const window = trustedWindow(event);
    const contents = window.webContents;
    if (!watched.has(contents.id)) {
      watched.add(contents.id);
      const clear = () => {
        if (owner === contents.id) invalidate();
      };
      contents.once('destroyed', () => {
        watched.delete(contents.id);
        clear();
      });
      contents.on('render-process-gone', clear);
      contents.on(
        'did-start-navigation',
        (_event, _url, inPlace, mainFrame) => {
          if (mainFrame && !inPlace) clear();
        },
      );
    }
    return window;
  };
  ipcMain.handle(IPC_CHANNELS.inspectPreviewCache, (event) => {
    windowFor(event);
    return service.inspect();
  });
  ipcMain.handle(IPC_CHANNELS.previewCacheCleanup, async (event) => {
    const windowId = windowFor(event).webContents.id;
    invalidate();
    owner = windowId;
    const current = revision;
    const preview = await service.preview();
    if (
      windowFor(event).webContents.id !== windowId ||
      owner !== windowId ||
      current !== revision
    )
      throw new Error('清理预览已失效，请重新检查预览缓存');
    token = preview.token;
    return preview;
  });
  ipcMain.handle(
    IPC_CHANNELS.executePreviewCacheCleanup,
    (event, input: unknown) => {
      const windowId = windowFor(event).webContents.id;
      if (
        typeof input !== 'string' ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input) ||
        input !== token ||
        owner !== windowId
      )
        throw new Error('清理预览已失效，请重新检查预览缓存');
      token = null;
      revision += 1;
      return service.execute(input);
    },
  );
  ipcMain.handle(IPC_CHANNELS.cancelPreviewCacheOperations, (event) => {
    windowFor(event);
    invalidate();
  });
}
