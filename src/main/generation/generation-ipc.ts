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

export function registerGenerationIpc(
  library: Library,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  const id = (value: unknown) => {
    if (!isId(value)) throw new Error('无效的项目或素材标识');
    return value;
  };
  const requestId = (value: unknown) => {
    if (
      typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      )
    )
      throw new Error('无效的素材导入标识');
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
    async (
      event,
      projectId: unknown,
      importId: unknown,
    ): Promise<ReferenceImportResult> => {
      const window = trustedWindow(event);
      const validatedId = id(projectId);
      const validatedImportId = requestId(importId);
      library.projects.summary(validatedId);
      return library.referenceImports.run(
        window.webContents.id,
        validatedId,
        validatedImportId,
        async () => {
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
          trustedWindow(event);
          return result;
        },
        (progress) => {
          if (!window.isDestroyed() && !window.webContents.isDestroyed())
            window.webContents.send(
              IPC_CHANNELS.referenceImportProgress,
              progress,
            );
        },
      );
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.cancelReferenceImport,
    (event, importId: unknown) => {
      const window = trustedWindow(event);
      return library.referenceImports.cancel(
        window.webContents.id,
        requestId(importId),
      );
    },
  );
  ipcMain.handle(IPC_CHANNELS.prepareReferenceImportsForLeave, (event) => {
    const window = trustedWindow(event);
    return library.referenceImports.prepareForLeave(window.webContents.id);
  });
  ipcMain.handle(IPC_CHANNELS.resumeReferenceSaves, (event, token: unknown) => {
    const window = trustedWindow(event);
    library.referenceImports.resumeAfterLeave(
      window.webContents.id,
      requestId(token),
    );
  });
}
