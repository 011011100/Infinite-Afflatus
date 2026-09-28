import { contextBridge, ipcRenderer } from 'electron';
import { type DesktopBridge, IPC_CHANNELS } from '../shared/desktop';

const desktop: DesktopBridge = {
  saveInteractions: (settings) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveInteractions, settings),
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
  getLibrary: () => ipcRenderer.invoke(IPC_CHANNELS.state),
  onLibraryChanged: (listener) => {
    const changed = () => listener();
    ipcRenderer.on(IPC_CHANNELS.changed, changed);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.changed, changed);
    };
  },
  createProject: (name) => ipcRenderer.invoke(IPC_CHANNELS.createProject, name),
  openProject: (id) => ipcRenderer.invoke(IPC_CHANNELS.openProject, id),
  renameProject: (id, name) =>
    ipcRenderer.invoke(IPC_CHANNELS.renameProject, id, name),
  saveViewport: (id, viewport) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveViewport, id, viewport),
  patchCanvas: (id, patch) =>
    ipcRenderer.invoke(IPC_CHANNELS.patchCanvas, id, patch),
  importVideos: (id) => ipcRenderer.invoke(IPC_CHANNELS.importVideos, id),
  chooseDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.chooseDirectory),
  startMigration: (token) =>
    ipcRenderer.invoke(IPC_CHANNELS.startMigration, token),
  cancelMigration: () => ipcRenderer.invoke(IPC_CHANNELS.cancelMigration),
  retryCleanup: () => ipcRenderer.invoke(IPC_CHANNELS.retryCleanup),
  retrySave: (id) => ipcRenderer.invoke(IPC_CHANNELS.retrySave, id),
  revealRoot: () => ipcRenderer.invoke(IPC_CHANNELS.revealRoot),
};

contextBridge.exposeInMainWorld('desktop', desktop);
