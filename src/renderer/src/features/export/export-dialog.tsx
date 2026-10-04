import {
  Check,
  Download,
  FolderOpen,
  ListVideo,
  LoaderCircle,
  X,
} from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import { flushPendingChanges } from '@/features/lifecycle/pending-saves';
import type {
  SequenceExportJob,
  SequenceExportOptions,
} from '../../../../shared/export';
import { exportRunning, useExports } from './use-exports';

type ExportTarget = {
  projectId: string;
  cardId: string;
  clipCount: number;
  duration: number;
};
const labels: Record<SequenceExportJob['status'], string> = {
  queued: '等待导出',
  preparing: '准备素材',
  encoding: '正在导出',
  finalizing: '正在校验',
  completed: '导出完成',
  cancelled: '已取消',
  failed: '导出失败',
};

export function ExportButton({
  disabled,
  onOpen,
  ...target
}: ExportTarget & { disabled: boolean; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
      >
        <Download />
        导出视频
      </Button>
      {open && <ExportDialog target={target} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ExportTaskButton() {
  const [open, setOpen] = useState(false);
  const { jobs } = useExports();
  if (!jobs.length) return null;
  const active = jobs.some(exportRunning);
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {active ? (
          <LoaderCircle className="animate-spin motion-reduce:animate-none" />
        ) : (
          <ListVideo />
        )}
        {active ? '正在导出' : '导出任务'}
      </Button>
      {open && <ExportDialog onClose={() => setOpen(false)} />}
    </>
  );
}

export function ExportDialog({
  target,
  onClose,
}: {
  target?: ExportTarget;
  onClose: () => void;
}) {
  const { jobs, error, busy, run } = useExports();
  const [resolution, setResolution] =
    useState<SequenceExportOptions['resolution']>('1080p');
  const [frameRate, setFrameRate] =
    useState<SequenceExportOptions['frameRate']>(30);
  const id = useId();
  const active = jobs.some(exportRunning);
  return (
    <Modal
      title={target ? '导出视频' : '导出任务'}
      onClose={onClose}
      error={error}
    >
      {target && (
        <section className="mb-6 space-y-4">
          <p className="text-sm">
            将当前{target.clipCount > 1 ? '组合' : '视频'}导出为 MP4 ·{' '}
            {target.clipCount} 段 · {target.duration.toFixed(1)} 秒
          </p>
          <p className="text-xs leading-5 text-muted-foreground">
            按已保存的顺序与裁剪范围输出。画幅跟随第一段，其他画面等比适配；保留原始素材。
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label htmlFor={`${id}-resolution`} className="text-xs">
                清晰度上限
              </label>
              <Select
                id={`${id}-resolution`}
                value={resolution}
                disabled={busy || active}
                onChange={(event) =>
                  setResolution(
                    event.target.value as SequenceExportOptions['resolution'],
                  )
                }
              >
                <option value="1080p">1080p</option>
                <option value="720p">720p</option>
              </Select>
            </div>
            <div className="space-y-2">
              <label htmlFor={`${id}-rate`} className="text-xs">
                帧率
              </label>
              <Select
                id={`${id}-rate`}
                value={frameRate}
                disabled={busy || active}
                onChange={(event) =>
                  setFrameRate(
                    Number(
                      event.target.value,
                    ) as SequenceExportOptions['frameRate'],
                  )
                }
              >
                {[24, 25, 30, 60].map((rate) => (
                  <option key={rate} value={rate}>
                    {rate} 帧 / 秒
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <Button
            className="w-full"
            disabled={busy || active}
            onClick={() =>
              void run(async () => {
                if (!(await flushPendingChanges()))
                  throw new Error('还有修改未保存，请重试保存后再导出。');
                await window.desktop.startExport(
                  target.projectId,
                  target.cardId,
                  { resolution, frameRate },
                );
              })
            }
          >
            <Download />
            {active
              ? '当前导出完成后可继续'
              : busy
                ? '正在准备…'
                : '选择位置并导出'}
          </Button>
          <p className="text-xs text-muted-foreground">
            请选择新的文件名，已有文件不会被覆盖。导出期间可收起窗口继续编辑；退出应用会取消未完成的导出。
          </p>
        </section>
      )}
      <section
        className="max-h-72 space-y-3 overflow-auto"
        aria-label="导出任务列表"
      >
        {!jobs.length && !target && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            暂无导出任务。在视频播放与编辑页导出视频。
          </p>
        )}
        {jobs.map((job) => (
          <article key={job.id} className="rounded-lg border p-3">
            <div className="flex items-center gap-2">
              {job.status === 'completed' ? (
                <Check className="size-4 text-primary" />
              ) : exportRunning(job) ? (
                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
              ) : null}
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {job.projectName}
              </span>
              <span className="text-xs text-muted-foreground">
                {labels[job.status]}
              </span>
              {exportRunning(job) && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={busy}
                  aria-label={`取消导出 ${job.projectName}`}
                  onClick={() =>
                    void run(() => window.desktop.cancelExport(job.id))
                  }
                >
                  <X />
                </Button>
              )}
            </div>
            {exportRunning(job) && (
              <div className="mt-3 flex items-center gap-3">
                <progress
                  aria-label={`${job.projectName} 导出进度`}
                  className="h-1.5 w-full accent-primary"
                  max={1}
                  value={job.progress}
                />
                <span className="text-xs tabular-nums text-muted-foreground">
                  {Math.floor(job.progress * 100)}%
                </span>
              </div>
            )}
            {job.error && (
              <p
                role="alert"
                className="mt-2 break-words text-xs text-destructive"
              >
                {job.error}
              </p>
            )}
            {(job.status === 'failed' || job.status === 'cancelled') && (
              <Button
                className="mt-2"
                variant="outline"
                size="sm"
                disabled={busy || active}
                title="按当前已保存的组合重新导出"
                onClick={() =>
                  void run(async () => {
                    if (!(await flushPendingChanges()))
                      throw new Error('还有修改未保存，请重试保存后再导出。');
                    await window.desktop.startExport(
                      job.projectId,
                      job.cardId,
                      job.options,
                    );
                  })
                }
              >
                重新导出
              </Button>
            )}
            {job.status === 'completed' && (
              <div className="mt-2 flex items-center gap-2">
                <p
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                  title={job.outputPath}
                >
                  {job.outputPath}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(() => window.desktop.revealExport(job.id))
                  }
                >
                  <FolderOpen />
                  显示文件
                </Button>
              </div>
            )}
          </article>
        ))}
      </section>
    </Modal>
  );
}
