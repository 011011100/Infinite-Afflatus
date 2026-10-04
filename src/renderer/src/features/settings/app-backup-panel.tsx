import { FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppBackups } from './use-app-backups';

const time = (value: string) => new Date(value).toLocaleString('zh-CN');
const bytes = (value: number) => `${value.toLocaleString('zh-CN')} 字节`;

export function AppBackupPanel({
  active = true,
  disabled = false,
}: {
  active?: boolean;
  disabled?: boolean;
}) {
  const state = useAppBackups(active);
  const { list, created, busy } = state;
  return (
    <section
      aria-label="应用索引与设置备份"
      aria-busy={!!busy}
      className="mt-6 space-y-3 border-t pt-5"
    >
      <h3 className="text-sm font-medium">应用索引与设置备份</h3>
      <p className="text-xs leading-5 text-muted-foreground">
        在本机保留项目索引、应用设置和历史任务记录，用于应用数据库损坏时恢复。不会修改当前项目。
      </p>
      <p className="text-xs leading-5 text-muted-foreground">
        不包含项目媒体、暂存结果或独立恢复草稿的文件；恢复时这些文件原地保留。完整项目请使用
        .afflatus 项目包。本机备份不能防止本机磁盘损坏。
      </p>
      {list && (
        <p className="break-all rounded-lg border bg-canvas p-3 text-xs">
          <span className="font-medium">本机备份位置：</span>
          {list.directory}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!!busy || disabled}
          onClick={() => void state.create()}
        >
          {busy === 'creating' ? '正在创建备份…' : '创建本机备份'}
        </Button>
        <Button
          variant="ghost"
          disabled={!!busy}
          onClick={() => void state.refresh()}
        >
          {busy === 'listing' ? '正在读取备份…' : '刷新备份列表'}
        </Button>
        <Button
          variant="ghost"
          disabled={!!busy}
          onClick={() => void state.reveal()}
        >
          <FolderOpen />
          打开备份位置
        </Button>
      </div>
      {disabled && (
        <p className="text-xs text-muted-foreground">
          项目存储正在处理中，请完成后再创建备份。
        </p>
      )}
      {state.error && (
        <p
          role="alert"
          className="break-words text-xs leading-5 text-destructive"
        >
          {state.error}
        </p>
      )}
      {created && (
        <p role="status" className="text-xs leading-5">
          已创建本机备份：{time(created.createdAt)} · {bytes(created.bytes)}。
        </p>
      )}
      {list &&
        (list.backups.length ? (
          <ul
            aria-label="本机应用备份列表"
            className="max-h-64 space-y-3 overflow-auto rounded-lg border p-3 text-xs"
          >
            {list.backups.map((backup) => (
              <li
                key={backup.id}
                className="space-y-1 border-b pb-3 last:border-0 last:pb-0"
              >
                <p className="font-medium">
                  <time dateTime={backup.createdAt}>
                    {time(backup.createdAt)}
                  </time>
                </p>
                <p className="break-all text-muted-foreground">
                  原项目保存目录：{backup.root}
                </p>
                <p className="text-muted-foreground">
                  {backup.projectCount} 个项目 · {backup.saveCount} 条历史任务 ·{' '}
                  {bytes(backup.bytes)} · 应用版本 {backup.appVersion}
                </p>
                {!backup.restorable && (
                  <p className="break-words text-destructive">
                    当前不能用于恢复：
                    {backup.reason ?? '请在启动故障入口重新检查此备份。'}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p role="status" className="text-xs text-muted-foreground">
            暂无本机备份。
          </p>
        ))}
      {!!list?.issues.length && (
        <details className="text-xs">
          <summary className="cursor-pointer">
            {list.issues.length} 项备份无法完整读取，原文件已保留
          </summary>
          <ul className="mt-2 max-h-40 space-y-2 overflow-auto">
            {list.issues.map((issue) => (
              <li key={issue.file} className="break-all">
                {issue.file}：{issue.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        恢复仅在应用启动失败时提供，需重新核对备份和原项目位置；运行中的应用不会用备份替换数据库。
      </p>
      {list?.recovery && (
        <div className="space-y-2 rounded-lg border p-3 text-xs">
          <p className="font-medium">
            上次恢复：{time(list.recovery.restoredAt)}
          </p>
          <p className="break-words">{list.recovery.warning}</p>
          <p>
            保留待核对：{list.recovery.retainedJobCount} 条历史任务 ·{' '}
            {list.recovery.retainedFileCount} 个文件。
          </p>
          <p className="break-all text-muted-foreground">
            原资料保留位置：{list.recovery.retainedDirectory}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => void state.reveal(true)}
          >
            打开保留资料位置
          </Button>
        </div>
      )}
    </section>
  );
}
