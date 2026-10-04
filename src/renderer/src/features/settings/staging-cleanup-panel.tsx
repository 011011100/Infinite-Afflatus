import { Button } from '@/components/ui/button';
import { useStagingCleanup } from './use-staging-cleanup';

const bytes = (size: number) => `${size.toLocaleString('zh-CN')} 字节`;

export function StagingCleanupPanel() {
  const state = useStagingCleanup();
  const { preview, result } = state;
  return (
    <section
      className="mt-6 space-y-3 border-t pt-5"
      aria-label="未完成导入暂存"
    >
      <h3 className="text-sm font-medium">未完成的本地导入</h3>
      <p className="text-xs leading-5 text-muted-foreground">
        可检查失败或取消导入留下的临时文件，确认后释放占用空间。原文件、完整接收的结果和云端结果都会保留。
      </p>
      <Button
        variant="outline"
        disabled={!!state.busy}
        onClick={() => void state.inspect()}
      >
        {state.busy === 'checking'
          ? '正在检查…'
          : preview
            ? '重新检查'
            : '检查未完成导入'}
      </Button>
      {state.error && (
        <p role="alert" className="text-xs leading-5 text-destructive">
          {state.error}
        </p>
      )}
      {preview && (
        <section
          className="space-y-3 rounded-lg border bg-canvas p-4"
          aria-label="暂存清理预览"
          aria-busy={!!state.busy}
        >
          <h4 className="text-sm font-medium">清理未完成导入</h4>
          <p className="text-sm">
            可清理 {preview.files.length} 个临时文件 · {bytes(preview.bytes)}
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            只删除已确认由本应用创建、且未完成导入的临时副本，项目素材和源文件都会保留。清理后如需这些素材，请重新导入原文件。
          </p>
          {!!preview.files.length && (
            <details className="text-xs">
              <summary className="cursor-pointer">查看待清理文件</summary>
              <ul className="mt-2 max-h-44 space-y-2 overflow-auto">
                {preview.files.map((file) => (
                  <li key={file.jobId} className="flex justify-between gap-3">
                    <span className="min-w-0 break-all">{file.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {bytes(file.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!!preview.retained.length && (
            <details className="text-xs">
              <summary className="cursor-pointer">
                另有 {preview.retained.length} 项保留
              </summary>
              <ul className="mt-2 max-h-44 space-y-2 overflow-auto">
                {preview.retained.map((item) => (
                  <li key={item.jobId} className="break-words">
                    <span>
                      {item.name}
                      {item.bytes === null ? '' : ` · ${bytes(item.bytes)}`}
                    </span>
                    <p className="mt-1 text-muted-foreground">{item.reason}</p>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!preview.files.length ? (
            <p role="status" className="text-xs text-muted-foreground">
              没有可安全清理的临时文件。无法确认可安全删除的历史文件会继续保留。
            </p>
          ) : (
            !state.valid &&
            !state.busy && (
              <p role="status" className="text-xs text-muted-foreground">
                此预览不能继续执行，请重新检查后确认。
              </p>
            )
          )}
          <div className="flex flex-wrap gap-2">
            {!!preview.files.length && (
              <Button
                disabled={!state.valid || !!state.busy}
                onClick={() => void state.execute()}
              >
                {state.busy === 'cleaning'
                  ? '正在清理…'
                  : `清理 ${preview.files.length} 个临时文件`}
              </Button>
            )}
            <Button
              variant="ghost"
              disabled={!!state.busy}
              onClick={state.dismiss}
            >
              暂不清理
            </Button>
          </div>
        </section>
      )}
      {result && (
        <div role="status" className="space-y-2 rounded-lg border p-3 text-xs">
          <p>
            上次清理：已清理 {result.removedCount} 个临时文件，释放{' '}
            {bytes(result.removedBytes)}。
          </p>
          {result.retained.map((item) => (
            <p key={item.jobId} className="break-words text-muted-foreground">
              仍需处理：{item.name}：{item.reason}。
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
