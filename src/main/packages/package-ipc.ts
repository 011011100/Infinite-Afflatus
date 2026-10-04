import { join } from 'node:path';
import {
  app,
  type BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
} from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import { outputName } from '../desktop/output-name';
import { isId } from '../projects/project-service';
import type { Library } from '../storage/library';

export function registerPackageIpc(
  library: Library,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
): void {
  ipcMain.handle(IPC_CHANNELS.cancelProjectPackage, (event) => {
    trustedWindow(event);
    library.packages.cancel();
  });
  const id = (value: unknown) => {
    if (!isId(value)) throw new Error('无效的项目标识');
    return value;
  };
  ipcMain.handle(
    IPC_CHANNELS.inspectProjectPackage,
    (event, projectId: unknown) => {
      trustedWindow(event);
      return library.packages.inspect(id(projectId));
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.exportProjectPackage,
    async (event, projectId: unknown) => {
      const window = trustedWindow(event);
      const project = library.projects.summary(id(projectId));
      const name = outputName(project.name);
      const choice = await dialog.showSaveDialog(window, {
        title: '导出项目包',
        buttonLabel: '导出项目包',
        defaultPath: join(app.getPath('documents'), `${name}.afflatus`),
        filters: [{ name: '无限画布项目包', extensions: ['afflatus'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (choice.canceled || !choice.filePath) return null;
      if (!choice.filePath.toLowerCase().endsWith('.afflatus'))
        throw new Error('请使用 .afflatus 作为项目包扩展名');
      trustedWindow(event);
      const result = await library.packages.export(project.id, choice.filePath);
      return result.path;
    },
  );
  ipcMain.handle(IPC_CHANNELS.importProjectPackage, async (event) => {
    const choice = await dialog.showOpenDialog(trustedWindow(event), {
      title: '导入项目包',
      buttonLabel: '导入为独立项目',
      properties: ['openFile'],
      filters: [{ name: '无限画布项目包', extensions: ['afflatus'] }],
    });
    if (choice.canceled || !choice.filePaths[0]) return null;
    trustedWindow(event);
    const project = await library.packages.import(choice.filePaths[0]);
    library.emit();
    return project;
  });
  ipcMain.handle(
    IPC_CHANNELS.duplicateProject,
    async (event, projectId: unknown) => {
      trustedWindow(event);
      const project = await library.packages.duplicate(id(projectId));
      library.emit();
      return project;
    },
  );
}
