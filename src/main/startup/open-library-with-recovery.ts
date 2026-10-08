import { dirname, join } from 'node:path';
import { app, dialog, safeStorage, shell } from 'electron';
import { AppBackupRecovery } from '../backups/app-backup-recovery';
import { RootRelocationService } from '../relocation/root-relocation-service';
import { errorMessage } from '../storage/database';
import { Library } from '../storage/library';
import { LibraryOpenError } from '../storage/library-open-error';
import { pathInfo } from '../storage/startup-checks';
import { restoreAppBackupFromDialogs } from './app-backup-dialogs';
import { relocateRootFromDialogs } from './root-relocation-dialogs';
import { StartupLifetime } from './startup-lifetime';
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

export async function openLibraryWithRecovery(
  userData: string,
  defaultRoot: string,
): Promise<Library | null> {
  const backups = new AppBackupRecovery(userData, app.getVersion());
  const relocation = new RootRelocationService(userData);
  const acquired: { library: Library | null } = { library: null };
  const lifetime = new StartupLifetime(app, async () => {
    await relocation.close();
    await acquired.library?.close();
  });
  let result: Library | null = null;
  const errors: unknown[] = [];
  try {
    result = await runStartupRecovery(
      () =>
        lifetime.track(async () => {
          const library = await Library.open(
            userData,
            defaultRoot,
            undefined,
            app.getVersion(),
            {
              arkSecrets: {
                isEncryptionAvailable: () =>
                  safeStorage.isEncryptionAvailable(),
                encryptString: (value) => safeStorage.encryptString(value),
                decryptString: (value) => safeStorage.decryptString(value),
                ...(process.platform === 'linux'
                  ? {
                      getSelectedStorageBackend: () =>
                        safeStorage.getSelectedStorageBackend(),
                    }
                  : {}),
              },
              ...(app.isPackaged
                ? {
                    mediaTools: {
                      bundleDirectory: join(
                        process.resourcesPath,
                        'media-tools',
                      ),
                    },
                  }
                : {}),
            },
          );
          acquired.library = library;
          if (lifetime.signal.aborted) {
            await library.close();
            throw lifetime.signal.reason;
          }
          return library;
        }),
      async (failure, locationError) => {
        const canRelocate = await lifetime
          .track(() => relocation.available())
          .catch(() => false);
        if (lifetime.signal.aborted) return 'quit';
        const root =
          failure instanceof LibraryOpenError ? failure.projectRoot : null;
        const choices: { label: string; action: StartupRecoveryAction }[] = [
          { label: '重试', action: 'retry' },
          ...(canRelocate
            ? [
                {
                  label: '重新定位原项目目录',
                  action: 'relocate-root' as const,
                },
              ]
            : []),
          { label: '查看应用数据位置', action: 'show-data' },
          { label: '检查本机备份', action: 'restore-backup' },
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
        return lifetime.signal.aborted
          ? 'quit'
          : (choices[result.response]?.action ?? 'quit');
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
      () =>
        restoreAppBackupFromDialogs(
          {
            list: () => lifetime.track(() => backups.list()),
            preview: (id) => lifetime.track(() => backups.preview(id)),
            restore: (token) => lifetime.track(() => backups.restore(token)),
          },
          dialog,
          lifetime.signal,
        ),
      () => relocateRootFromDialogs(relocation, dialog, lifetime.signal),
      lifetime.signal,
    );
  } catch (error) {
    errors.push(error);
  }
  try {
    await relocation.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length || lifetime.signal.aborted) {
    try {
      await acquired.library?.close();
    } catch (error) {
      errors.push(error);
    }
  }
  lifetime.detach();
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, '启动恢复未能安全结束');
  return lifetime.signal.aborted ? null : result;
}
