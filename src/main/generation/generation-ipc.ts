import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  type BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
} from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import {
  MAX_REFERENCES,
  type ReferenceImportResult,
} from '../../shared/generation/draft';
import {
  REFERENCE_EXTENSIONS,
  referenceKind,
} from '../../shared/generation/reference-files';
import { isId } from '../projects/project-service';
import { errorMessage } from '../storage/database';
import { localFileStream } from '../storage/files';
import type { Library } from '../storage/library';

export function registerGenerationIpc(
  library: Library,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  const id = (value: unknown) => {
    if (!isId(value)) throw new Error('无效的项目或素材标识');
    return value;
  };
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
      const imported: ReferenceImportResult = { assetIds: [], errors: [] };
      if (result.canceled) return imported;
      if (result.filePaths.length > MAX_REFERENCES)
        throw new Error(`一次最多导入 ${MAX_REFERENCES} 个素材`);
      for (const file of result.filePaths) {
        try {
          const extension = extname(file).slice(1).toLowerCase();
          const kind = referenceKind(extension);
          if (!kind) throw new Error('不支持的素材格式');
          if (kind === 'text' && (await stat(file)).size > 1024 * 1024)
            throw new Error('文本素材不能超过 1 MB');
          const job = await library.acceptResult(
            {
              projectId: validatedId,
              resultKey: `reference:${randomUUID()}`,
              name: basename(file),
              kind,
              usage: 'reference',
              extension,
            },
            await localFileStream(file),
          );
          imported.assetIds.push(job.id);
        } catch (error) {
          imported.errors.push(`${basename(file)}：${errorMessage(error)}`);
        }
      }
      await library.saves.idle();
      return imported;
    },
  );
}
