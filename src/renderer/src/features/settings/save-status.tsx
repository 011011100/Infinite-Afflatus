import { Button } from '@/components/ui/button';
import type { SaveJob } from '../../../../shared/models';
import { useStagingInspection } from './use-staging-inspection';

export function SaveStatus({
  jobs,
  migrating,
  restartRequired = false,
  run,
  blockedProjectId,
  onManageStaging,
}: {
  jobs: SaveJob[];
  migrating: boolean;
  restartRequired?: boolean | undefined;
  run: (operation: () => Promise<unknown>) => Promise<void>;
  blockedProjectId?: string | undefined;
  onManageStaging: () => void;
}) {
  const inspection = useStagingInspection(jobs);
  const pending = jobs.filter((job) => job.status !== 'saved');
  if (!pending.length && !migrating && !restartRequired) return null;
  const failed = pending.filter((job) => job.status === 'failed');
  const receiving = pending.filter((job) => job.status === 'receiving').length;
  const incomplete = failed.filter(
    (job) => inspection.itemFor(job)?.category === 'incomplete-local',
  ).length;
  const waiting = pending.filter(
    (job) =>
      job.status === 'ready' ||
      job.status === 'saving' ||
      inspection.itemFor(job)?.canRetry,
  ).length;
  const other = pending.length - receiving - incomplete - waiting;
  const summary = [
    waiting && `${waiting} 个结果待保存`,
    receiving && `${receiving} 项正在接收`,
    incomplete && `${incomplete} 项导入未完成`,
    other && `${other} 项暂存需检查`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <aside
      className="shrink-0 border-b bg-background px-6 py-2 text-xs"
      aria-label="保存任务"
      aria-live="polite"
    >
      <p className="text-muted-foreground">
        {restartRequired
          ? '目录切换确认中断，写入已暂停，请关闭并重新打开应用。'
          : migrating
            ? '正在迁移项目目录，新结果将暂存后自动保存。'
            : `${summary}。`}
      </p>
      {!!failed.length && (
        <div className="flex items-center gap-3">
          {inspection.error && (
            <span className="min-w-0 flex-1 text-muted-foreground">
              暂存检查未完成：{inspection.error}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (inspection.error) inspection.refresh();
              onManageStaging();
            }}
          >
            管理暂存
          </Button>
        </div>
      )}
      {failed.map((job) => {
        const item = inspection.itemFor(job);
        const unfinished = item?.category === 'incomplete-local';
        return (
          <div key={job.id} className="mt-1 flex items-center gap-3">
            <span
              className={`min-w-0 truncate ${item?.cancelled ? 'text-muted-foreground' : 'text-destructive'}`}
            >
              {job.name}：
              {unfinished
                ? item.cancelled
                  ? '导入已取消，未完成内容未加入项目'
                  : '导入未完成，请重新导入原文件'
                : item
                  ? (job.error ?? item.reason)
                  : inspection.checking
                    ? '正在检查暂存状态…'
                    : (job.error ?? '暂存状态尚未确认')}
            </span>
            {item?.canRetry && (
              <Button
                variant="ghost"
                size="sm"
                disabled={restartRequired || job.projectId === blockedProjectId}
                onClick={() => {
                  void run(() => window.desktop.retrySave(job.id));
                }}
              >
                重试保存
              </Button>
            )}
          </div>
        );
      })}
    </aside>
  );
}
