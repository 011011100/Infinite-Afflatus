import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import {
  app,
  type BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  shell,
} from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import type { Viewport } from '../../shared/models';
import {
  isId,
  validateName,
  validateViewport,
} from '../projects/project-service';
import { localFileStream } from '../storage/files';
import type { Library } from '../storage/library';

export function registerDesktop(
  library: Library,
  getWindow: () => BrowserWindow | null,
): void {
  const trustedWindow = (event: IpcMainInvokeEvent) => {
    if (library.isClosing) throw new Error('应用正在关闭');
    const window = getWindow();
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error('Untrusted desktop request');
    return window;
  };
  const id = (value: unknown) => {
    if (!isId(value)) throw new Error('无效的项目或任务标识');
    return value;
  };
  ipcMain.handle(IPC_CHANNELS.appInfo, (event) => {
    trustedWindow(event);
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
    };
  });
  ipcMain.handle(IPC_CHANNELS.state, (event) => {
    trustedWindow(event);
    return library.state();
  });
  ipcMain.handle(IPC_CHANNELS.createProject, async (event, name: unknown) => {
    trustedWindow(event);
    const project = await library.projects.create(validateName(name));
    library.emit();
    return project;
  });
  ipcMain.handle(IPC_CHANNELS.openProject, (event, projectId: unknown) => {
    trustedWindow(event);
    return library.projects.open(id(projectId));
  });
  ipcMain.handle(
    IPC_CHANNELS.renameProject,
    async (event, projectId: unknown, name: unknown) => {
      trustedWindow(event);
      await library.projects.update(id(projectId), {
        name: validateName(name),
      });
      library.emit();
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.saveViewport,
    async (event, projectId: unknown, viewport: Viewport) => {
      trustedWindow(event);
      validateViewport(viewport);
      await library.projects.update(id(projectId), { viewport });
    },
  );
  ipcMain.handle(IPC_CHANNELS.chooseDirectory, async (event) => {
    const result = await dialog.showOpenDialog(trustedWindow(event), {
      title: '选择新的项目保存目录',
      buttonLabel: '选择此文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    const path = result.filePaths[0];
    return result.canceled || !path ? null : library.migration.prepare(path);
  });
  ipcMain.handle(IPC_CHANNELS.startMigration, (event, token: unknown) => {
    trustedWindow(event);
    return library.migration.start(id(token));
  });
  ipcMain.handle(IPC_CHANNELS.cancelMigration, (event) => {
    trustedWindow(event);
    library.migration.cancel();
  });
  ipcMain.handle(IPC_CHANNELS.retryCleanup, (event) => {
    trustedWindow(event);
    return library.migration.retryCleanup();
  });
  ipcMain.handle(IPC_CHANNELS.retrySave, (event, jobId: unknown) => {
    trustedWindow(event);
    return library.saves.retry(id(jobId));
  });
  ipcMain.handle(IPC_CHANNELS.revealRoot, async (event) => {
    trustedWindow(event);
    const error = await shell.openPath(library.state().root);
    if (error) throw new Error(error);
  });
  ipcMain.handle(
    IPC_CHANNELS.importVideos,
    async (event, projectId: unknown) => {
      const window = trustedWindow(event);
      const validatedId = id(projectId);
      library.projects.summary(validatedId);
      const result = await dialog.showOpenDialog(window, {
        title: '导入视频',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '视频', extensions: ['mp4', 'mov', 'webm', 'm4v'] }],
      });
      if (result.canceled) return;
      for (const file of result.filePaths) {
        const extension = extname(file).slice(1).toLowerCase();
        if (!['mp4', 'mov', 'webm', 'm4v'].includes(extension))
          throw new Error('不支持的视频文件类型');
        await library.acceptResult(
          {
            projectId: validatedId,
            resultKey: `import:${randomUUID()}`,
            name: basename(file),
            kind: 'video',
            extension,
          },
          await localFileStream(file),
        );
      }
    },
  );
  library.subscribe(() => {
    const window = getWindow();
    if (window && !window.isDestroyed())
      window.webContents.send(IPC_CHANNELS.changed);
  });
}
