import { join } from 'node:path';
import { app, type BrowserWindow, dialog, session } from 'electron';
import { registerDesktop } from './desktop/ipc';
import {
  registerMediaScheme,
  serveProjectMedia,
} from './desktop/media-protocol';
import { SaveLifecycle } from './desktop/save-lifecycle';
import { createWindow } from './desktop/window';
import { openLibraryWithRecovery } from './startup/open-library-with-recovery';
import { errorMessage } from './storage/database';
import type { Library } from './storage/library';

app.setName('Infinite Afflatus');
// Isolated desktop smoke checks do not touch the user's library.
if (!app.isPackaged && process.env.AFFLATUS_USER_DATA)
  app.setPath('userData', process.env.AFFLATUS_USER_DATA);
registerMediaScheme();
let mainWindow: BrowserWindow | null = null;
let library: Library | null = null;
let quitting = false;
let quitRequest: Promise<void> | null = null;
let saveLifecycle: SaveLifecycle | null = null;
function showWindow(): void {
  if (quitting || library?.isClosing) return;
  mainWindow = createWindow();
  saveLifecycle?.protect(mainWindow, () => quitting || quitRequest !== null);
  mainWindow.once('closed', () => {
    mainWindow = null;
  });
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (quitting) return;
    mainWindow?.show();
    mainWindow?.focus();
  });
  void app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId('com.infiniteafflatus.desktop');
      session.defaultSession.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      const defaultRoot =
        (!app.isPackaged && process.env.AFFLATUS_PROJECTS_DIR) ||
        join(app.getPath('documents'), 'Infinite Afflatus', 'Projects');
      library = await openLibraryWithRecovery(
        app.getPath('userData'),
        defaultRoot,
      );
      if (!library) {
        app.quit();
        return;
      }
      registerDesktop(library, () => mainWindow);
      saveLifecycle = new SaveLifecycle(
        () => mainWindow,
        () => {
          library?.packages.cancel();
          library?.health.cancel();
          void library?.exports.cancelPreparation().catch((error: unknown) => {
            console.warn('Export preparation cleanup failed:', error);
          });
        },
      );
      serveProjectMedia(library);
      showWindow();
      app.on('activate', () => {
        if (!mainWindow) showWindow();
      });
    })
    .catch((error: unknown) => {
      dialog.showErrorBox(
        '无法打开项目库',
        `${errorMessage(error)}\n请确认保存目录和磁盘可用后重新打开应用。`,
      );
      app.quit();
    });
}
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', (event) => {
  if (!library) return;
  event.preventDefault();
  if (quitRequest || quitting) return;
  const currentLibrary = library;
  quitRequest = (async () => {
    if (saveLifecycle && !(await saveLifecycle.prepare())) return;
    quitting = true;
    await currentLibrary.close();
    // Only drain the storage after every renderer draft has reached it.
    app.exit(0);
  })()
    .catch((error: unknown) => {
      console.error('Shutdown error:', error);
      app.exit(1);
    })
    .finally(() => {
      quitRequest = null;
    });
});
