import {
  type BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
} from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import type { GenerationWorkspace } from '../../shared/generation/workspace';
import type { ProjectSummary } from '../../shared/models';
import { draftId } from './draft-validation';
import type { WorkspaceDraftService } from './workspace-draft-service';

export interface DraftProjectAccess {
  summary: (id: string) => ProjectSummary;
  read: (id: string) => Promise<GenerationWorkspace>;
  restore: (
    id: string,
    baseline: GenerationWorkspace,
    workspace: GenerationWorkspace,
  ) => Promise<GenerationWorkspace>;
}

export function registerWorkspaceDraftIpc(
  drafts: WorkspaceDraftService,
  projects: DraftProjectAccess,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
) {
  ipcMain.handle(
    IPC_CHANNELS.protectWorkspaceDraft,
    (event, projectId: unknown, input: unknown) => {
      trustedWindow(event);
      return drafts.protect(projects.summary(draftId(projectId)), input);
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.listWorkspaceDrafts,
    (event, projectId: unknown) => {
      trustedWindow(event);
      return drafts.list(draftId(projectId));
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.acknowledgeWorkspaceDraft,
    async (event, projectId: unknown, input: unknown) => {
      trustedWindow(event);
      const id = draftId(projectId);
      return drafts.acknowledge(id, input, await projects.read(id));
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.recoverWorkspaceDraft,
    (event, projectId: unknown, input: unknown) => {
      trustedWindow(event);
      const id = draftId(projectId);
      return drafts.recover(
        projects.summary(id),
        input,
        () => projects.read(id),
        (baseline, workspace) => projects.restore(id, baseline, workspace),
      );
    },
  );
  let selecting = false;
  ipcMain.handle(
    IPC_CHANNELS.exportWorkspaceDraft,
    async (event, projectId: unknown, input: unknown) => {
      const window = trustedWindow(event);
      const project = projects.summary(draftId(projectId));
      if (selecting) throw new Error('请先完成或取消当前文件选择');
      selecting = true;
      try {
        const choice = await dialog.showSaveDialog(window, {
          title: '导出只读镜头恢复文件',
          defaultPath: `${project.name.replace(/[<>:"/\\|?*]/g, '_')}.afflatus-draft.json`,
          filters: [
            { name: '镜头恢复文件（不是完整项目包）', extensions: ['json'] },
          ],
        });
        if (choice.canceled || !choice.filePath) return null;
        trustedWindow(event);
        const path = choice.filePath.endsWith('.afflatus-draft.json')
          ? choice.filePath
          : `${choice.filePath}.afflatus-draft.json`;
        return await drafts.export(project, input, path);
      } finally {
        selecting = false;
      }
    },
  );
}
