import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import type { PreviewCacheItem } from '../../../../shared/preview-cache';
import { usePreviewCacheCleanup } from './use-preview-cache-cleanup';

const bytes = (size: number) => `${size.toLocaleString('zh-CN')} 字节`;
const key = (item: PreviewCacheItem) =>
  `${item.projectId}:${item.relativePath}`;

function CacheFiles({ items }: { items: PreviewCacheItem[] }) {
  return (
    <ul className="mt-2 max-h-44 space-y-3 overflow-auto">
      {items.map((item) => (
        <li key={key(item)} className="space-y-1 break-words">
          <p>
            {item.projectName} ·{' '}
            {item.bytes === null ? '占用未知' : bytes(item.bytes)}
          </p>
          <p className="break-all text-muted-foreground">{item.relativePath}</p>
          <p className="text-muted-foreground">{item.reason}</p>
        </li>
      ))}
    </ul>
  );
}

export function PreviewCachePanel({
  active = true,
  disabled = false,
}: {
  active?: boolean;
  disabled?: boolean;
}) {
  const state = usePreviewCacheCleanup(active, disabled);
  const { preview, result, busy } = state;
  const inspectButton = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLHeadingElement>(null);
  const outcome = useRef<HTMLDivElement>(null);
  const focusPreview = useRef(false);
  const focusOutcome = useRef(false);
  const operationControl = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  const items = preview ? [...preview.files, ...preview.retained] : [];
  const measuredBytes = items.reduce(
    (total, item) => total + (item.bytes ?? 0),
    0,
  );

  useEffect(() => {
    if (!active || disabled) {
      focusPreview.current = false;
      focusOutcome.current = false;
      restoreFocus.current = false;
      return;
    }
    if (busy) return;
    if (restoreFocus.current) {
      restoreFocus.current = false;
      inspectButton.current?.focus();
    } else if (focusOutcome.current) {
      focusOutcome.current = false;
      if (
        document.activeElement === document.body ||
        document.activeElement === operationControl.current
      )
        (result ? outcome.current : inspectButton.current)?.focus();
    } else if (focusPreview.current) {
      focusPreview.current = false;
      // A late scan must not steal focus from another settings control.
      if (
        document.activeElement === inspectButton.current ||
        document.activeElement === document.body
      )
        (state.error ? inspectButton.current : summary.current)?.focus();
    }
  }, [active, disabled, busy, result, state.error]);

  return (
    <section
      aria-label="预览缓存"
      aria-busy={!!busy}
      className="mt-6 space-y-3 border-t pt-5"
    >
      <h3 className="text-sm font-medium">预览缓存</h3>
      <p className="text-xs leading-5 text-muted-foreground">
        检查轻量预览的磁盘占用，确认后清理可重建的缓存。下次需要时会重新生成；视频处理工具不可用时仍可使用原片。
      </p>
      <p className="text-xs leading-5 text-muted-foreground">
        原素材、编辑草稿、完整结果和暂存文件均保留。正在生成或使用中的缓存、身份不明的文件也会保留。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          ref={inspectButton}
          variant="outline"
          disabled={!active || disabled || !!busy}
          onClick={() => {
            focusPreview.current = true;
            void state.inspect();
          }}
        >
          {busy === 'checking'
            ? '正在检查缓存…'
            : preview || result
              ? '重新检查缓存'
              : '检查预览缓存'}
        </Button>
        {busy === 'checking' && (
          <Button
            variant="ghost"
            onClick={() => {
              focusPreview.current = false;
              restoreFocus.current = true;
              state.dismiss();
            }}
          >
            取消检查
          </Button>
        )}
      </div>
      {disabled && (
        <p className="text-xs text-muted-foreground">
          项目存储正在处理中，请完成后再检查或清理缓存。
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
      {preview && (
        <section
          aria-label="预览缓存清理预览"
          className="space-y-3 rounded-lg border bg-canvas p-4"
        >
          <h4
            ref={summary}
            tabIndex={-1}
            className="rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            预览缓存检查结果
          </h4>
          <p role="status" className="text-sm">
            已检查 {items.filter((item) => item.kind === 'proxy').length}{' '}
            项受管预览 · 缓存目录已核实占用 {bytes(measuredBytes)}
          </p>
          <p className="text-sm">
            可清理 {preview.files.length} 个缓存文件，释放{' '}
            {bytes(preview.bytes)}
          </p>
          {preview.incomplete && (
            <p className="text-xs leading-5 text-muted-foreground">
              部分项目、目录或文件无法核实，以上占用不是完整总量；这些内容会保留。
            </p>
          )}
          <p className="text-xs leading-5 text-muted-foreground">
            只清理下面列出的受管预览副本。执行前会再次核对原片、缓存身份和使用状态；不符合条件的文件继续保留。
          </p>
          {!!preview.files.length && (
            <details className="text-xs">
              <summary className="cursor-pointer">
                查看 {preview.files.length} 个待清理缓存文件
              </summary>
              <CacheFiles items={preview.files} />
            </details>
          )}
          {!!preview.retained.length && (
            <details className="text-xs">
              <summary className="cursor-pointer">
                另有 {preview.retained.length} 项保留，查看原因
              </summary>
              <CacheFiles items={preview.retained} />
            </details>
          )}
          {!preview.files.length ? (
            <p role="status" className="text-xs text-muted-foreground">
              没有可安全清理的预览缓存。
            </p>
          ) : !state.valid && !busy ? (
            <p role="status" className="text-xs text-muted-foreground">
              此预览已失效，请重新检查后确认。
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {!!preview.files.length && (
              <Button
                variant="destructive"
                disabled={!active || disabled || !state.valid || !!busy}
                onClick={(event) => {
                  operationControl.current = event.currentTarget;
                  focusOutcome.current = true;
                  void state.execute();
                }}
              >
                {busy === 'cleaning'
                  ? '正在清理缓存…'
                  : `确认清理 ${preview.files.length} 个缓存文件`}
              </Button>
            )}
            {busy === 'cleaning' ? (
              <Button
                variant="ghost"
                disabled={state.stopping}
                onClick={(event) => {
                  operationControl.current = event.currentTarget;
                  void state.stop();
                }}
              >
                {state.stopping ? '正在停止…' : '停止剩余清理'}
              </Button>
            ) : (
              <Button
                variant="ghost"
                disabled={!!busy}
                onClick={() => {
                  focusPreview.current = false;
                  state.dismiss();
                  inspectButton.current?.focus();
                }}
              >
                暂不清理缓存
              </Button>
            )}
          </div>
          {busy === 'cleaning' && (
            <p role="status" className="text-xs text-muted-foreground">
              停止或离开此页会停止剩余清理，已清理的缓存不会还原。
            </p>
          )}
        </section>
      )}
      {busy === 'cleaning' && !preview && (
        <div className="space-y-2">
          <p role="status" className="text-xs text-muted-foreground">
            {state.stopping
              ? '正在停止剩余清理，等待实际结果…'
              : '清理仍在进行，可再次尝试停止。'}
          </p>
          <Button
            variant="ghost"
            disabled={state.stopping}
            onClick={(event) => {
              operationControl.current = event.currentTarget;
              void state.stop();
            }}
          >
            {state.stopping ? '正在停止…' : '停止剩余清理'}
          </Button>
        </div>
      )}
      {result && (
        <div
          ref={outcome}
          role="status"
          tabIndex={-1}
          className="space-y-2 rounded-lg border p-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <p>
            {result.cancelled ? '清理已停止：' : '上次清理：'}已清理{' '}
            {result.removedCount} 个缓存文件，实际释放{' '}
            {bytes(result.removedBytes)}。
          </p>
          {!!result.retained.length && (
            <details>
              <summary className="cursor-pointer">
                {result.retained.length} 项未清理，查看原因
              </summary>
              <CacheFiles items={result.retained} />
            </details>
          )}
          <p className="text-muted-foreground">再次清理前需重新检查并确认。</p>
        </div>
      )}
    </section>
  );
}
