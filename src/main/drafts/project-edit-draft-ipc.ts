import {
  type BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
} from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import type { ProjectSnapshot, ProjectSummary } from '../../shared/models';
import type { ProjectEditDraftRecord } from '../../shared/project-edit-draft';
import { draftId } from './draft-validation';
import type { ProjectEditDraftService } from './project-edit-draft-service';

export interface ProjectEditAccess {
  summary: (id: string) => ProjectSummary;
  read: (id: string) => Promise<ProjectSnapshot>;
  restore: (
    id: string,
    record: ProjectEditDraftRecord,
    beforeWrite: () => Promise<void>,
  ) => Promise<ProjectSnapshot>;
}

export function registerProjectEditDraftIpc(
  drafts: ProjectEditDraftService,
  projects: ProjectEditAccess,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
  changed: () => void = () => {},
) {
  ipcMain.handle(
    IPC_CHANNELS.protectProjectEditDraft,
    (event, projectId: unknown, input: unknown) => {
      trustedWindow(event);
      return drafts.protect(projects.summary(draftId(projectId)), input);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.listProjectEditDrafts,
    (event, projectId: unknown) => {
      trustedWindow(event);
      return drafts.list(draftId(projectId));
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.acknowledgeProjectEditDraft,
    async (event, projectId: unknown, input: unknown) => {
      trustedWindow(event);
      const id = draftId(projectId);
      return drafts.acknowledge(id, input, await projects.read(id));
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.recoverProjectEditDraft,
    async (event, projectId: unknown, input: unknown) => {
      trustedWindow(event);
      const id = draftId(projectId);
      const snapshot = await drafts.recover(
        projects.summary(id),
        input,
        (record, beforeWrite) => projects.restore(id, record, beforeWrite),
      );
      changed();
      return snapshot;
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.discardProjectEditDraft,
    (event, projectId: unknown, input: unknown) => {
      trustedWindow(event);
      return drafts.discard(draftId(projectId), input);
    },
  );
  let selecting = false;
  ipcMain.handle(
    IPC_CHANNELS.exportProjectEditDraft,
    async (event, projectId: unknown, input: unknown) => {
      const window = trustedWindow(event);
      const project = projects.summary(draftId(projectId));
      if (selecting) throw new Error('请先完成或取消当前文件选择');
      selecting = true;
      try {
        const choice = await dialog.showSaveDialog(window, {
          title: '导出只读名称与裁剪恢复文件',
          defaultPath: `${project.name.replace(/[<>:"/\\|?*]/g, '_')}.afflatus-edit-draft.json`,
          filters: [
            {
              name: '名称与裁剪恢复文件（不是完整项目包）',
              extensions: ['json'],
            },
          ],
        });
        if (choice.canceled || !choice.filePath) return null;
        trustedWindow(event);
        const path = choice.filePath.endsWith('.afflatus-edit-draft.json')
          ? choice.filePath
          : `${choice.filePath}.afflatus-edit-draft.json`;
        return await drafts.export(project, input, path);
      } finally {
        selecting = false;
      }
    },
  );
}
