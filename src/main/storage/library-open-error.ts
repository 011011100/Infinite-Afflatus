import { errorMessage } from './database';

export class LibraryOpenError extends Error {
  constructor(
    reason: unknown,
    readonly userData: string,
    readonly projectRoot: string | null,
    readonly stage: 'application' | 'projects' | 'recovery',
  ) {
    const code = (reason as NodeJS.ErrnoException | null)?.code;
    const message = errorMessage(reason);
    const detail =
      code === 'ENOENT'
        ? '原文件或保存目录未连接，请恢复原位置后重试'
        : ['EACCES', 'EPERM', 'EROFS'].includes(code ?? '') ||
            /readonly|read-only|permission denied/i.test(message)
          ? '无法读写原位置，请检查磁盘连接、目录权限或只读状态'
          : /file is not a database|database disk image is malformed/i.test(
                message,
              )
            ? '应用数据库无法读取或已损坏。请保留原文件，放回可靠的原库备份后重试'
            : /database is locked|database is busy/i.test(message)
              ? '应用数据库正被占用，请关闭使用此资料库的其他程序后重试'
              : message;
    super(detail, { cause: reason });
    this.name = 'LibraryOpenError';
  }
}
