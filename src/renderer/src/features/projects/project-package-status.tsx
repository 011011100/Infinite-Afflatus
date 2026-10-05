import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ProjectPackagePhase } from '../../../../shared/project-package';
import type { ProjectPackageOperationState } from './use-project-package-operation';

export function packageSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
const phases: Record<ProjectPackagePhase, string> = {
  choosing: '请选择项目包文件或导出位置…',
  waiting: '正在等待当前保存完成…',
  preparing: '正在准备项目…',
  copying: '正在复制并校验素材…',
  verifying: '正在核对项目内容…',
  finalizing: '正在完成项目包，请稍候…',
  cancelling: '正在停止项目包操作并清理未完成文件…',
  completed: '正在确认项目包处理结果…',
  cancelled: '正在确认取消结果…',
  failed: '正在确认处理结果…',
};

export function ProjectPackageStatus({
  operation,
}: {
  operation: ProjectPackageOperationState;
}) {
  const { busy, saving, cancelling, progress, notice } = operation;
  if (!busy && !notice) return null;
  const stopping = cancelling || progress?.phase === 'cancelling';
  const title = !busy
    ? notice
    : stopping
      ? phases.cancelling
      : saving
        ? '正在保存当前修改…'
        : progress
          ? phases[progress.phase]
          : '正在准备项目包操作…';
  const hasBytes = busy && progress && progress.operation !== 'inspect';
  const total = hasBytes ? progress.totalBytes : null;
  return (
    <section
      aria-label="项目包进度"
      className="mt-4 rounded-lg border bg-background p-3 text-sm"
    >
      <div className="flex items-start gap-3">
        {busy && (
          <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none" />
        )}
        <p
          role="status"
          aria-live="polite"
          className="min-w-0 flex-1 break-words"
        >
          {title}
        </p>
        {busy && (
          <Button
            variant="outline"
            size="sm"
            disabled={stopping || progress?.canCancel === false}
            onClick={() => void operation.cancel()}
          >
            {stopping ? '正在停止…' : '取消项目包操作'}
          </Button>
        )}
      </div>
      {busy && progress?.fileName && (
        <p
          className="mt-2 truncate text-xs text-muted-foreground"
          title={progress.fileName}
        >
          {progress.fileName}
        </p>
      )}
      {busy && progress && (progress.totalFiles !== null || hasBytes) && (
        <p className="mt-2 text-xs tabular-nums text-muted-foreground">
          {progress.totalFiles !== null &&
            `已处理 ${progress.completedFiles} / ${progress.totalFiles} 个文件`}
          {hasBytes &&
            `${progress.totalFiles !== null ? ' · ' : ''}已写入 ${packageSizeLabel(progress.completedBytes)}${total !== null ? ` / ${packageSizeLabel(total)}` : ''}`}
        </p>
      )}
      {hasBytes && total !== null && total > 0 && (
        <progress
          aria-label="项目包已写入字节"
          value={Math.min(progress.completedBytes, total)}
          max={total}
          className="mt-2 h-1.5 w-full accent-primary"
        />
      )}
    </section>
  );
}
