import {
  type BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
} from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import { isId } from '../projects/project-service';
import type { Library } from '../storage/library';
import {
  findRetainedAssetSource,
  validateRetainedAssetSource,
} from './retained-asset-source';

export function registerRecoveryIpc(
  library: Library,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
  getWindow: () => BrowserWindow | null,
) {
  let selecting = false;
  const id = (value: unknown) => {
    if (!isId(value)) throw new Error('无效的项目或素材标识');
    return value;
  };
  ipcMain.handle(
    IPC_CHANNELS.scanProjectHealth,
    (event, projectId: unknown, mode: unknown) => {
      trustedWindow(event);
      if (mode !== 'quick' && mode !== 'full')
        throw new Error('无效的素材检查模式');
      return library.health.scan(id(projectId), mode);
    },
  );
  ipcMain.handle(IPC_CHANNELS.cancelProjectHealth, (event) => {
    trustedWindow(event);
    library.health.cancel();
  });
  ipcMain.handle(
    IPC_CHANNELS.restoreMissingAsset,
    async (event, projectId: unknown, assetId: unknown) => {
      const window = trustedWindow(event);
      const project = id(projectId);
      const asset = id(assetId);
      library.projects.summary(project);
      if (selecting) throw new Error('请先完成或取消当前文件选择');
      const epoch = library.health.cancellationVersion;
      selecting = true;
      const current = () => {
        if (library.health.cancellationVersion !== epoch) return false;
        if (trustedWindow(event) !== window || window.isDestroyed())
          throw new Error('项目窗口已变化，请重新检查项目素材');
        return true;
      };
      try {
        const retained = await findRetainedAssetSource(library, project, asset);
        if (!current()) return null;
        let source: string | undefined;
        let useRetained = false;
        if (retained) {
          const answer = await dialog.showMessageBox(window, {
            type: 'question',
            title: '发现保留的素材副本',
            message: '发现保留的素材副本，验证内容一致后恢复',
            detail: `素材：${retained.name}\n大小：${retained.bytes.toLocaleString('zh-CN')} 字节\n保留位置：${retained.path}\n\n本次恢复仅补回缺失的原文件，不会覆盖已有文件，并会保留这份副本。`,
            buttons: ['验证并恢复', '选择其他原文件', '取消'],
            defaultId: 2,
            cancelId: 2,
            noLink: true,
          });
          if (!current() || answer.response === 2) return null;
          if (answer.response === 0) {
            source = retained.path;
            useRetained = true;
          } else if (answer.response !== 1) return null;
        }
        if (!source) {
          const choice = await dialog.showOpenDialog(window, {
            title: '选择内容完全相同的原素材',
            buttonLabel: '验证并恢复',
            properties: ['openFile'],
          });
          if (!current() || choice.canceled) return null;
          if (
            choice.filePaths.length !== 1 ||
            typeof choice.filePaths[0] !== 'string' ||
            !choice.filePaths[0]
          )
            throw new Error('请选择一个原素材文件');
          source = choice.filePaths[0];
        }
        const report = await library.health.restore(
          project,
          asset,
          source,
          async () => {
            if (!current()) throw new Error('素材恢复已取消');
            if (useRetained && retained)
              await validateRetainedAssetSource(library, retained);
            if (!current()) throw new Error('素材恢复已取消');
          },
        );
        library.emit();
        return report;
      } catch (error) {
        if (!current()) return null;
        throw error;
      } finally {
        selecting = false;
      }
    },
  );
  library.health.subscribe((progress) => {
    const window = getWindow();
    if (window && !window.isDestroyed())
      window.webContents.send(IPC_CHANNELS.projectHealthProgress, progress);
  });
}
