import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import { type AppInfo, IPC_CHANNELS } from '../shared/desktop';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    title: 'Infinite Afflatus',
    backgroundColor: '#f8fafc',
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow = window;
  window.once('ready-to-show', () => window.show());
  window.once('closed', () => {
    mainWindow = null;
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const loading =
    !app.isPackaged && rendererUrl
      ? window.loadURL(rendererUrl)
      : window.loadFile(join(import.meta.dirname, '../renderer/index.html'));

  void loading.catch((error: unknown) => {
    console.error('Unable to load the application window:', error);
    app.quit();
  });
}

void app.whenReady().then(() => {
  app.setName('Infinite Afflatus');
  app.setAppUserModelId('com.infiniteafflatus.desktop');
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => {
      callback(false);
    },
  );
  session.defaultSession.setPermissionCheckHandler(() => false);

  ipcMain.handle(IPC_CHANNELS.appInfo, (event): AppInfo => {
    if (
      !mainWindow ||
      event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame
    ) {
      throw new Error('Untrusted desktop request');
    }

    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
    };
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
