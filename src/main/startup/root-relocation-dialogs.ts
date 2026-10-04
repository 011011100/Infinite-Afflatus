import type {
  MessageBoxOptions,
  MessageBoxReturnValue,
  OpenDialogOptions,
  OpenDialogReturnValue,
} from 'electron';
import type { RootRelocationService } from '../relocation/root-relocation-service';

type Relocation = Pick<
  RootRelocationService,
  'available' | 'preview' | 'confirm' | 'cancel'
>;

interface NativeDialogs {
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
}

/** A changed path is checked first; only explicit consent publishes that exact preview. */
export async function relocateRootFromDialogs(
  relocation: Relocation,
  dialogs: NativeDialogs,
  signal?: AbortSignal,
): Promise<boolean> {
  const cancel = () => relocation.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) return false;
    if (!(await relocation.available())) {
      if (signal?.aborted) return false;
      throw new Error('当前资料不满足原目录重新定位条件，请回到故障提示重试');
    }
    if (signal?.aborted) return false;
    const selection = await dialogs.showOpenDialog({
      title: '选择移动或改名后的原项目目录',
      buttonLabel: '检查原项目目录',
      properties: ['openDirectory'],
    });
    if (signal?.aborted || selection.canceled) return false;
    if (
      selection.filePaths.length !== 1 ||
      typeof selection.filePaths[0] !== 'string' ||
      !selection.filePaths[0]
    )
      throw new Error('请选择一个已存在的原项目目录');
    const preview = await relocation.preview(selection.filePaths[0]);
    if (signal?.aborted) return false;
    const confirmation = await dialogs.showMessageBox({
      type: 'warning',
      title: '确认重新定位原项目目录',
      message: `已找到 ${preview.projects.length} 个原项目`,
      detail: [
        `原保存位置：${preview.oldRoot}`,
        `当前保存位置：${preview.newRoot}`,
        `项目：${preview.projects.map((project) => project.name).join('、') || '无项目'}`,
        `${preview.pendingSaveCount} 个待保存任务。重新打开后，仍按保存队列规则处理。`,
        '仅更新原项目目录的位置记录，不复制、移动或删除项目文件，不创建空项目。',
        '原应用数据库会另存保留；项目素材、暂存文件和恢复草稿仍在原处。',
        '此检查确认目录和项目身份，不代表所有素材内容完好；打开后可使用“检查项目素材”。',
      ].join('\n\n'),
      buttons: ['确认位置并重新打开', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      ...(signal ? { signal } : {}),
    });
    if (signal?.aborted || confirmation.response !== 0) return false;
    if (
      !Number.isFinite(Date.parse(preview.expiresAt)) ||
      Date.parse(preview.expiresAt) <= Date.now()
    )
      throw new Error('目录检查结果已过期，请重新选择并检查原项目目录');
    await relocation.confirm(preview.token);
    // Confirm owns its durable publication once started. Do not cancel or
    // replace it with a second request, including when the app is quitting.
    return !signal?.aborted;
  } catch (error) {
    if (signal?.aborted) return false;
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    relocation.cancel();
  }
}
