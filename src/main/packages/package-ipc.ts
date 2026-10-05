import { join } from 'node:path';
import {
  app,
  type BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
} from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import type { ProjectPackageProgress } from '../../shared/project-package';
import { outputName } from '../desktop/output-name';
import { isId } from '../projects/project-service';
import type { Library } from '../storage/library';

export function registerPackageIpc(
  library: Library,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
): void {
  const id = (value: unknown) => {
    if (!isId(value)) throw new Error('无效的项目标识');
    return value;
  };
  const requestId = (value: unknown) => {
    if (
      typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    )
      throw new Error('无效的项目包操作标识');
    return value;
  };
  const report =
    (window: BrowserWindow) => (progress: ProjectPackageProgress) => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send(IPC_CHANNELS.projectPackageProgress, progress);
    };
  ipcMain.handle(IPC_CHANNELS.cancelProjectPackage, (event, token: unknown) => {
    const window = trustedWindow(event);
    return library.packageRequests.cancel(
      window.webContents.id,
      token === undefined ? undefined : requestId(token),
    );
  });
  ipcMain.handle(IPC_CHANNELS.preparePackageOperationsForLeave, (event) => {
    const window = trustedWindow(event);
    return library.packageRequests.prepareForLeave(window.webContents.id);
  });
  ipcMain.handle(
    IPC_CHANNELS.resumePackageOperations,
    (event, token: unknown) => {
      const window = trustedWindow(event);
      library.packageRequests.resumeAfterLeave(
        window.webContents.id,
        requestId(token),
      );
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.inspectProjectPackage,
    (event, projectId: unknown, token: unknown) => {
      const window = trustedWindow(event);
      const project = id(projectId);
      return library.packageRequests.run(
        window.webContents.id,
        requestId(token),
        'inspect',
        project,
        async () => true,
        (_selected, controls) => {
          trustedWindow(event);
          return library.packages.inspect(project, controls);
        },
        report(window),
      );
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.exportProjectPackage,
    async (event, projectId: unknown, token: unknown) => {
      const window = trustedWindow(event);
      const request = requestId(token);
      const project = library.projects.summary(id(projectId));
      const result = await library.packageRequests.run(
        window.webContents.id,
        request,
        'export',
        project.id,
        async () => {
          const choice = await dialog.showSaveDialog(window, {
            title: '导出项目包',
            buttonLabel: '导出项目包',
            defaultPath: join(
              app.getPath('documents'),
              `${outputName(project.name)}.afflatus`,
            ),
            filters: [{ name: '无限画布项目包', extensions: ['afflatus'] }],
            properties: ['createDirectory', 'showOverwriteConfirmation'],
          });
          trustedWindow(event);
          if (choice.canceled || !choice.filePath) return null;
          if (!choice.filePath.toLowerCase().endsWith('.afflatus'))
            throw new Error('请使用 .afflatus 作为项目包扩展名');
          return choice.filePath;
        },
        (path, controls) => {
          trustedWindow(event);
          return library.packages.export(project.id, path, controls);
        },
        report(window),
      );
      return result?.path ?? null;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.importProjectPackage,
    async (event, token: unknown) => {
      const window = trustedWindow(event);
      const result = await library.packageRequests.run(
        window.webContents.id,
        requestId(token),
        'import',
        null,
        async () => {
          const choice = await dialog.showOpenDialog(window, {
            title: '导入项目包',
            buttonLabel: '导入为独立项目',
            properties: ['openFile'],
            filters: [{ name: '无限画布项目包', extensions: ['afflatus'] }],
          });
          trustedWindow(event);
          if (choice.canceled) return null;
          if (choice.filePaths.length !== 1 || !choice.filePaths[0])
            throw new Error('请选择一个项目包文件');
          return choice.filePaths[0];
        },
        (path, controls) => {
          trustedWindow(event);
          return library.packages.import(path, controls);
        },
        report(window),
      );
      if (result) library.emit();
      return result;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.duplicateProject,
    async (event, projectId: unknown, token: unknown) => {
      const window = trustedWindow(event);
      const project = id(projectId);
      const result = await library.packageRequests.run(
        window.webContents.id,
        requestId(token),
        'duplicate',
        project,
        async () => true,
        (_selected, controls) => {
          trustedWindow(event);
          return library.packages.duplicate(project, undefined, controls);
        },
        report(window),
      );
      if (result) library.emit();
      return result;
    },
  );
}
