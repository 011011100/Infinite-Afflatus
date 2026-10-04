import { dirname, join } from 'node:path';
import { dialog, shell } from 'electron';
import { errorMessage } from '../storage/database';
import { Library } from '../storage/library';
import { LibraryOpenError } from '../storage/library-open-error';
import { pathInfo } from '../storage/startup-checks';
import {
  runStartupRecovery,
  type StartupRecoveryAction,
} from './startup-recovery';

async function revealDirectory(path: string): Promise<void> {
  let current = path;
  // A disconnected volume has no folder to open; show its nearest existing parent.
  for (;;) {
    if ((await pathInfo(current))?.isDirectory()) break;
    const parent = dirname(current);
    if (parent === current) throw new Error('该目录当前不可用');
    current = parent;
  }
  const error = await shell.openPath(current);
  if (error) throw new Error(error);
}

export function openLibraryWithRecovery(
  userData: string,
  defaultRoot: string,
): Promise<Library | null> {
  return runStartupRecovery(
    () => Library.open(userData, defaultRoot),
    async (failure, locationError) => {
      const root =
        failure instanceof LibraryOpenError ? failure.projectRoot : null;
      const choices: { label: string; action: StartupRecoveryAction }[] = [
        { label: '重试', action: 'retry' },
        { label: '查看应用数据位置', action: 'show-data' },
        ...(root
          ? [{ label: '查看原项目位置', action: 'show-projects' as const }]
          : []),
        { label: '退出', action: 'quit' },
      ];
      const result = await dialog.showMessageBox({
        type: 'error',
        title: '无法打开项目库',
        message:
          failure instanceof LibraryOpenError && failure.stage === 'projects'
            ? '原项目保存位置暂不可用'
            : '应用资料尚未打开',
        detail: [
          errorMessage(failure),
          root ? `原项目保存目录：${root}` : '未能安全确认原项目目录。',
          `应用数据库：${join(userData, 'app.sqlite')}`,
          '请重新连接原磁盘、恢复目录权限，或放回原应用数据库后重试。应用不会自动改用新目录、重建或删除已有资料。',
          ...(locationError ? [locationError] : []),
        ].join('\n\n'),
        buttons: choices.map((choice) => choice.label),
        defaultId: 0,
        cancelId: choices.length - 1,
        noLink: true,
      });
      return choices[result.response]?.action ?? 'quit';
    },
    async (action, failure) => {
      const root =
        failure instanceof LibraryOpenError ? failure.projectRoot : null;
      if (action === 'show-projects' && !root)
        throw new Error('无法安全确认原项目目录');
      await revealDirectory(
        action === 'show-projects' && root ? root : userData,
      );
    },
  );
}
