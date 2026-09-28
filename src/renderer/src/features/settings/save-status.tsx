import { Button } from '@/components/ui/button';
import type { SaveJob } from '../../../../shared/models';

export function SaveStatus({
  jobs,
  migrating,
  run,
}: {
  jobs: SaveJob[];
  migrating: boolean;
  run: (operation: () => Promise<unknown>) => Promise<void>;
}) {
  const pending = jobs.filter((job) => job.status !== 'saved');
  if (!pending.length && !migrating) return null;
  const failed = pending.filter((job) => job.status === 'failed');
  return (
    <aside
      className="shrink-0 border-b bg-background px-6 py-2 text-xs"
      aria-label="保存任务"
      aria-live="polite"
    >
      <p className="text-muted-foreground">
        {migrating
          ? '正在迁移项目目录，新结果将暂存后自动保存。'
          : `${pending.length} 个结果待保存。`}
      </p>
      {failed.map((job) => (
        <div key={job.id} className="mt-1 flex items-center gap-3">
          <span className="min-w-0 truncate text-destructive">
            {job.name}：{job.error}
          </span>
          {job.sha256 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void run(() => window.desktop.retrySave(job.id));
              }}
            >
              重试保存
            </Button>
          )}
        </div>
      ))}
    </aside>
  );
}
