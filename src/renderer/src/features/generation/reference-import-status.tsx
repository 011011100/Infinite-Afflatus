import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ReferenceImportProgress } from '../../../../shared/generation/reference-import';

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export function ReferenceImportStatus({
  progress,
  notice,
  cancel,
  dismiss,
}: {
  progress: ReferenceImportProgress | null;
  notice: string | null;
  cancel: () => Promise<boolean>;
  dismiss: () => void;
}) {
  if (!progress && !notice) return null;
  const cancelling = progress?.phase === 'cancelling';
  const status = progress
    ? cancelling
      ? '正在停止导入，已完成的素材会保留…'
      : progress.phase === 'choosing'
        ? '请选择要导入的参考素材…'
        : progress.phase === 'finalizing'
          ? '正在确认文件…'
          : progress.phase === 'completed' || progress.phase === 'cancelled'
            ? '正在添加已完成素材…'
            : `正在导入 ${progress.fileIndex} / ${progress.totalFiles}`
    : notice;
  return (
    <section
      aria-label="参考素材导入"
      className="flex shrink-0 items-center gap-3 border-b bg-background px-5 py-2 text-xs"
    >
      {progress && <LoaderCircle className="size-3 shrink-0 animate-spin" />}
      <div className="min-w-0 flex-1" role="status" aria-live="polite">
        <p>{status}</p>
        {progress?.fileName && (
          <p className="mt-1 truncate text-muted-foreground">
            {progress.fileName} · 已接收 {bytes(progress.receivedBytes)}
            {progress.fileBytes !== null && ` / ${bytes(progress.fileBytes)}`}
            {` · 已完成 ${progress.acceptedCount} 个`}
          </p>
        )}
      </div>
      {progress ? (
        <Button
          size="xs"
          variant="outline"
          disabled={cancelling}
          onClick={() => void cancel()}
        >
          {cancelling ? '正在停止…' : '取消导入'}
        </Button>
      ) : (
        <Button size="xs" variant="ghost" onClick={dismiss}>
          关闭提示
        </Button>
      )}
    </section>
  );
}
