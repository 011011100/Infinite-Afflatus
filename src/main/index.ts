import { join } from 'node:path';
import { app, type BrowserWindow, dialog, session } from 'electron';
import { registerDesktop } from './desktop/ipc';
import {
  registerMediaScheme,
  serveProjectMedia,
} from './desktop/media-protocol';
import { createWindow } from './desktop/window';
import { errorMessage } from './storage/database';
import { Library } from './storage/library';

app.setName('Infinite Afflatus');
// Isolated desktop smoke checks do not touch the user's library.
if (!app.isPackaged && process.env.AFFLATUS_USER_DATA)
  app.setPath('userData', process.env.AFFLATUS_USER_DATA);
registerMediaScheme();
let mainWindow: BrowserWindow | null = null;
let library: Library | null = null;
let quitting = false;
function showWindow(): void {
  mainWindow = createWindow();
  mainWindow.once('closed', () => {
    mainWindow = null;
  });
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
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
      library = await Library.open(app.getPath('userData'), defaultRoot);
      registerDesktop(library, () => mainWindow);
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
  if (quitting || !library) return;
  event.preventDefault();
  quitting = true;
  void library
    .close()
    .then(() => app.quit())
    .catch((error: unknown) => {
      console.error('Shutdown error:', error);
      app.exit(1);
    });
});
