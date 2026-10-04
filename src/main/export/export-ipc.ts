import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  app,
  type BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  shell,
} from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import type { SequenceExportOptions } from '../../shared/export';
import { outputName } from '../desktop/output-name';
import { isId } from '../projects/project-service';
import type { Library } from '../storage/library';

export function registerExportIpc(
  library: Library,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
): void {
  const id = (value: unknown) => {
    if (!isId(value)) throw new Error('无效的导出标识');
    return value;
  };
  ipcMain.handle(IPC_CHANNELS.listExports, (event) => {
    trustedWindow(event);
    return library.exports.list();
  });
  ipcMain.handle(
    IPC_CHANNELS.startExport,
    async (
      event,
      projectId: unknown,
      cardId: unknown,
      options: SequenceExportOptions,
    ) => {
      const window = trustedWindow(event);
      const project = library.projects.summary(id(projectId));
      const validatedCardId = id(cardId);
      const cancellationVersion = library.exports.cancellationVersion;
      const name = outputName(project.name);
      const choice = await dialog.showSaveDialog(window, {
        title: '导出视频',
        buttonLabel: '导出 MP4',
        defaultPath: join(app.getPath('videos'), `${name}.mp4`),
        filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (
        choice.canceled ||
        !choice.filePath ||
        cancellationVersion !== library.exports.cancellationVersion
      )
        return null;
      trustedWindow(event);
      try {
        return await library.exports.start(
          project.id,
          validatedCardId,
          choice.filePath,
          options,
        );
      } catch (error) {
        if (cancellationVersion !== library.exports.cancellationVersion)
          return null;
        throw error;
      }
    },
  );
  ipcMain.handle(IPC_CHANNELS.cancelExport, (event, jobId: unknown) => {
    trustedWindow(event);
    library.exports.cancel(id(jobId));
  });
  ipcMain.handle(IPC_CHANNELS.cancelExportPreparation, (event) => {
    trustedWindow(event);
    return library.exports.cancelPreparation();
  });
  ipcMain.handle(IPC_CHANNELS.revealExport, async (event, jobId: unknown) => {
    trustedWindow(event);
    const job = library.exports.get(id(jobId));
    if (job.status !== 'completed') throw new Error('视频尚未导出完成');
    const file = await lstat(job.outputPath).catch(() => null);
    if (!file?.isFile() || file.isSymbolicLink())
      throw new Error('导出文件已移动或不存在');
    shell.showItemInFolder(job.outputPath);
  });
}
