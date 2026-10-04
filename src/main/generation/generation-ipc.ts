import {
  type BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
} from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import type { ReferenceImportResult } from '../../shared/generation/draft';
import { REFERENCE_EXTENSIONS } from '../../shared/generation/reference-files';
import { isId } from '../projects/project-service';
import type { Library } from '../storage/library';
import { importReferenceFiles } from './import-references';

export function registerGenerationIpc(
  library: Library,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  const id = (value: unknown) => {
    if (!isId(value)) throw new Error('无效的项目或素材标识');
    return value;
  };
  ipcMain.handle(
    IPC_CHANNELS.getGenerationWorkspace,
    (event, projectId: unknown) => {
      trustedWindow(event);
      return library.generation.readWorkspace(id(projectId));
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.saveGenerationWorkspace,
    async (event, projectId: unknown, workspace: unknown) => {
      trustedWindow(event);
      const saved = await library.generation.saveWorkspace(
        id(projectId),
        workspace,
      );
      library.emit();
      return saved;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.getGenerationDraft,
    (event, projectId: unknown) => {
      trustedWindow(event);
      return library.generation.read(id(projectId));
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.saveGenerationDraft,
    async (event, projectId: unknown, draft: unknown) => {
      trustedWindow(event);
      const saved = await library.generation.save(id(projectId), draft);
      library.emit();
      return saved;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.readReferenceText,
    (event, projectId: unknown, assetId: unknown) => {
      trustedWindow(event);
      return library.generation.readText(id(projectId), id(assetId));
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.importReferences,
    async (event, projectId: unknown): Promise<ReferenceImportResult> => {
      const window = trustedWindow(event);
      const validatedId = id(projectId);
      library.projects.summary(validatedId);
      const result = await dialog.showOpenDialog(window, {
        title: '添加参考素材',
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: '图片、视频、音频、文本',
            extensions: Object.values(REFERENCE_EXTENSIONS).flat(),
          },
        ],
      });
      if (result.canceled) return { assetIds: [], errors: [] };
      const imported = await importReferenceFiles(
        library,
        validatedId,
        result.filePaths,
      );
      await library.saves.idle();
      return imported;
    },
  );
}
