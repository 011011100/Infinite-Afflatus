import { realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  MessageBoxOptions,
  MessageBoxReturnValue,
  OpenDialogOptions,
  OpenDialogReturnValue,
} from 'electron';
import type {
  AppBackupList,
  AppBackupRestorePreview,
  AppBackupRestoreResult,
} from '../../shared/app-backup';

interface BackupRecovery {
  list(): Promise<AppBackupList>;
  preview(id: string): Promise<AppBackupRestorePreview>;
  restore(token: string): Promise<AppBackupRestoreResult>;
}

interface NativeDialogs {
  showMessageBox(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
}

const time = (value: string) => new Date(value).toLocaleString('zh-CN');

/** Check first, then request consent for that exact preview. Cancelling never opens storage. */
export async function restoreAppBackupFromDialogs(
  recovery: BackupRecovery,
  dialogs: NativeDialogs,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  const list = await recovery.list();
  if (signal?.aborted) return false;
  const latest = [...list.backups].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  )[0];
  if (!latest) {
    await dialogs.showMessageBox({
      type: 'info',
      title: '应用索引与设置备份',
      message: '尚无可读取的本机备份',
      detail: [
        '原资料保持不变。请放回原应用数据库或重新连接原保存盘后重试。',
        `本机备份位置：${list.directory}`,
        ...list.issues.map((issue) => `${issue.file}：${issue.message}`),
      ].join('\n\n'),
      buttons: ['返回'],
      noLink: true,
    });
    return false;
  }
  const selection = await dialogs.showMessageBox({
    type: 'info',
    title: '检查本机备份',
    message: `最近备份：${time(latest.createdAt)}`,
    detail: [
      `${latest.projectCount} 个项目索引 · 创建版本 ${latest.appVersion}`,
      `记录的项目保存目录：${latest.root}`,
      '检查不会替换当前资料。备份只包含应用索引、设置与历史任务记录，不包含项目媒体或暂存文件。',
      ...(latest.reason ? [latest.reason] : []),
    ].join('\n\n'),
    buttons: ['检查最近备份', '选择其他备份', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (signal?.aborted || selection.response === 2) return false;
  let id = latest.id;
  if (selection.response === 1) {
    const picked = await dialogs.showOpenDialog({
      title: '选择本机备份中的一个备份文件夹',
      defaultPath: list.directory,
      buttonLabel: '检查此备份',
      properties: ['openDirectory'],
    });
    if (signal?.aborted || picked.canceled) return false;
    if (picked.filePaths.length !== 1 || !picked.filePaths[0])
      throw new Error('请选择一个本机备份文件夹');
    const selectedPath = await realpath(picked.filePaths[0]);
    const selected = list.backups.find(
      (backup) => backup.id === basename(selectedPath),
    );
    if (
      !selected ||
      selectedPath !== (await realpath(join(list.directory, selected.id)))
    )
      throw new Error('此文件夹不属于当前应用的本机备份，未替换任何资料');
    id = selected.id;
  } else if (selection.response !== 0) return false;
  if (signal?.aborted) return false;
  const preview = await recovery.preview(id);
  if (signal?.aborted) return false;
  const confirmation = await dialogs.showMessageBox({
    type: 'warning',
    title: '确认恢复应用索引与设置',
    message: `恢复 ${time(preview.backup.createdAt)} 的备份`,
    detail: [
      `项目保存目录：${preview.backup.root}`,
      `已核对 ${preview.projectCount} 个当前项目索引。项目内容与素材保持现状，应用设置回到备份时。`,
      `原应用数据库及旁路文件将另存保留。${preview.retainedJobCount} 条历史任务和 ${preview.retainedFileCount} 个暂存文件保留待核对，不自动执行保存或清理。`,
      '镜头草稿、名称与裁剪恢复副本保留。此操作不能找回已被删除的项目或媒体。',
      ...preview.warnings,
    ].join('\n\n'),
    buttons: ['恢复并打开项目库', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (signal?.aborted || confirmation.response !== 0) return false;
  const result = await recovery.restore(preview.token);
  if (signal?.aborted) return false;
  await dialogs.showMessageBox({
    type: 'info',
    title: '应用索引与设置已恢复',
    message: '即将重新检查并打开项目库',
    detail: [
      `原资料保留位置：${result.retainedDirectory}`,
      result.report.warning,
    ].join('\n\n'),
    buttons: ['继续'],
    noLink: true,
  });
  return true;
}
