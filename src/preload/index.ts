import { contextBridge, ipcRenderer } from 'electron';
import { type DesktopBridge, IPC_CHANNELS } from '../shared/desktop';

const desktop: DesktopBridge = {
  getAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.appInfo),
};

contextBridge.exposeInMainWorld('desktop', desktop);
