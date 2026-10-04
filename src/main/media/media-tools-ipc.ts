import {
  type BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
} from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import type { MediaToolName } from '../../shared/media-tools';
import type { MediaToolSettings } from './media-tool-settings';

function toolName(value: unknown): MediaToolName {
  if (value !== 'ffmpeg' && value !== 'ffprobe')
    throw new Error('无效的视频处理组件。');
  return value;
}

export function registerMediaToolsIpc(
  service: MediaToolSettings,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(IPC_CHANNELS.getMediaToolSettings, (event) => {
    trustedWindow(event);
    return service.state();
  });
  ipcMain.handle(IPC_CHANNELS.checkMediaTools, (event) => {
    trustedWindow(event);
    return service.check();
  });
  ipcMain.handle(IPC_CHANNELS.chooseMediaTool, (event, value: unknown) => {
    const window = trustedWindow(event);
    const name = toolName(value);
    return service.choose(
      name,
      async () => {
        const choice = await dialog.showOpenDialog(window, {
          title: `选择 ${name === 'ffmpeg' ? 'FFmpeg' : 'FFprobe'} 可执行文件`,
          properties: ['openFile'],
          ...(process.platform === 'win32'
            ? { filters: [{ name: '可执行文件', extensions: ['exe'] }] }
            : {}),
        });
        if (choice.canceled) return null;
        if (choice.filePaths.length !== 1)
          throw new Error('请选择一个组件可执行文件。');
        return choice.filePaths[0] ?? null;
      },
      () => {
        if (trustedWindow(event) !== window)
          throw new Error('视频处理设置窗口已变化。');
      },
    );
  });
  ipcMain.handle(IPC_CHANNELS.resetMediaTool, (event, value: unknown) => {
    const window = trustedWindow(event);
    const name = value === 'all' ? 'all' : toolName(value);
    return service.reset(name, () => {
      if (trustedWindow(event) !== window)
        throw new Error('视频处理设置窗口已变化。');
    });
  });
}
