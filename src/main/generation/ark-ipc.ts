import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import type {
  ArkConfigurationInput,
  ArkGenerationTarget,
} from '../../shared/generation/ark-types';
import { isId } from '../projects/project-service';
import type { ArkGenerationService } from './ark-generation-service';

/** Secrets are write-only; only the current main-frame owner can confirm its preview. */
export function registerArkIpc(
  service: Pick<
    ArkGenerationService,
    | 'config'
    | 'configure'
    | 'preview'
    | 'submit'
    | 'cancelPreview'
    | 'list'
    | 'refresh'
    | 'retryDownload'
    | 'retrySave'
    | 'stopLocal'
    | 'cancelQueued'
    | 'adopt'
    | 'subscribe'
  >,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
  getWindow: () => BrowserWindow | null,
): void {
  const owners = new Map<number, number>();
  const ownerFor = (event: IpcMainInvokeEvent) => {
    const window = trustedWindow(event);
    const contents = window.webContents;
    if (!owners.has(contents.id)) {
      owners.set(contents.id, 0);
      const reset = () => {
        const generation = owners.get(contents.id) ?? 0;
        service.cancelPreview(`${contents.id}:${generation}`);
        owners.set(contents.id, generation + 1);
      };
      contents.once('destroyed', reset);
      contents.on('render-process-gone', reset);
      contents.on(
        'did-start-navigation',
        (_event, _url, inPlace, mainFrame) => {
          if (mainFrame && !inPlace) reset();
        },
      );
    }
    return `${contents.id}:${owners.get(contents.id)}`;
  };
  const jobId = (input: unknown) => {
    if (!isId(input)) throw new Error('无效的生成任务标识');
    return input;
  };
  const localId = (input: unknown, optional = false) => {
    if (optional && input === undefined) return undefined;
    if (typeof input !== 'string' || !/^[a-zA-Z0-9:-]{1,100}$/.test(input))
      throw new Error('无效的镜头或生成组标识');
    return input;
  };
  ipcMain.handle(IPC_CHANNELS.getArkConfig, (event) => {
    ownerFor(event);
    return service.config();
  });
  ipcMain.handle(IPC_CHANNELS.saveArkConfig, (event, input: unknown) => {
    const owner = ownerFor(event);
    return service.configure(input as ArkConfigurationInput, () => {
      if (ownerFor(event) !== owner)
        throw new Error('配置窗口已经变化，未保存设置');
    });
  });
  ipcMain.handle(
    IPC_CHANNELS.previewArkGeneration,
    async (event, input: unknown) => {
      const owner = ownerFor(event);
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('无效的生成目标');
      const target = input as ArkGenerationTarget;
      if (!isId(target.projectId)) throw new Error('无效的项目标识');
      localId(target.shotId);
      localId(target.groupId);
      const preview = await service.preview(owner, target, () => {
        if (ownerFor(event) !== owner)
          throw new Error('生成预览窗口已变化，请重新检查');
      });
      try {
        if (ownerFor(event) !== owner)
          throw new Error('生成预览窗口已变化，请重新检查');
        return preview;
      } catch (error) {
        service.cancelPreview(owner, preview.token);
        throw error;
      }
    },
  );
  ipcMain.handle(IPC_CHANNELS.submitArkGeneration, (event, input: unknown) => {
    const owner = ownerFor(event);
    if (!isId(input)) throw new Error('生成确认已失效，请重新检查');
    return service.submit(owner, input, () => {
      if (ownerFor(event) !== owner)
        throw new Error('生成确认窗口已变化，未发起请求');
    });
  });
  ipcMain.handle(IPC_CHANNELS.cancelArkPreview, (event, input: unknown) => {
    const owner = ownerFor(event);
    if (input !== undefined && !isId(input)) throw new Error('无效的生成预览');
    service.cancelPreview(owner, input as string | undefined);
  });
  ipcMain.handle(
    IPC_CHANNELS.listArkJobs,
    (event, projectId: unknown, shotId: unknown, groupId: unknown) => {
      ownerFor(event);
      if (!isId(projectId)) throw new Error('无效的项目标识');
      return service.list(
        projectId,
        localId(shotId, true),
        localId(groupId, true),
      );
    },
  );
  for (const [channel, method] of [
    [IPC_CHANNELS.refreshArkJob, 'refresh'],
    [IPC_CHANNELS.retryArkDownload, 'retryDownload'],
    [IPC_CHANNELS.retryArkSave, 'retrySave'],
    [IPC_CHANNELS.stopArkPolling, 'stopLocal'],
    [IPC_CHANNELS.cancelArkQueued, 'cancelQueued'],
  ] as const) {
    ipcMain.handle(channel, (event, input: unknown) => {
      ownerFor(event);
      return service[method](jobId(input));
    });
  }
  ipcMain.handle(
    IPC_CHANNELS.adoptArkJob,
    (event, input: unknown, revision: unknown) => {
      ownerFor(event);
      if (
        typeof revision !== 'number' ||
        !Number.isSafeInteger(revision) ||
        revision < 0
      )
        throw new Error('镜头版本无效，请先保存当前编辑');
      return service.adopt(jobId(input), revision);
    },
  );
  service.subscribe(() => {
    const window = getWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send(IPC_CHANNELS.arkJobsChanged);
  });
}
