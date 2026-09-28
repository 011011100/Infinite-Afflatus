import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

export function createWindow(): BrowserWindow {
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
  window.once('ready-to-show', () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const loading =
    !app.isPackaged && rendererUrl
      ? window.loadURL(rendererUrl)
      : window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  void loading.catch((error: unknown) => {
    console.error('Unable to load window:', error);
    app.quit();
  });
  return window;
}
