import {
  FileCheck2,
  FileWarning,
  FolderSearch,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import type { ProjectAssetIssue } from '../../../../shared/project-health';
import { useProjectHealth } from './use-project-health';

const labels: Record<ProjectAssetIssue['problem'], string> = {
  missing: '原文件缺失',
  changed: '内容已变化',
  unreadable: '无法读取',
  unsafe: '路径不可用',
};

export function ProjectHealthButton({
  projectId,
  disabled,
}: {
  projectId: string;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const health = useProjectHealth(projectId, disabled);
  const issues = health.report?.issues ?? [];
  const hasProblem = issues.length > 0 || !!health.error;
  return (
    <>
      <Button
        variant="ghost"
        size={hasProblem ? 'sm' : 'icon-sm'}
        aria-label={
          issues.length ? `${issues.length} 个素材需要检查` : '检查项目素材'
        }
        title="检查项目素材"
        onClick={() => setOpen(true)}
        className={hasProblem ? 'text-destructive' : 'text-muted-foreground'}
      >
        {health.busy ? (
          <LoaderCircle className="animate-spin motion-reduce:animate-none" />
        ) : hasProblem ? (
          <FileWarning />
        ) : (
          <FileCheck2 />
        )}
        {hasProblem &&
          (issues.length ? `${issues.length} 个素材异常` : '素材检查失败')}
      </Button>
      {open && (
        <Modal
          title="项目素材检查"
          onClose={() => setOpen(false)}
          error={health.error}
        >
          <p className="text-sm leading-6 text-muted-foreground">
            检查项目中的原始素材。文件缺失时，点击“找到原文件”；如有保留副本，可确认校验后恢复，也可自行选择原文件。卡片、裁剪、文本和生成组引用会保留。
          </p>
          {health.busy && (
            <div role="status" className="mt-4 rounded-lg bg-muted p-4 text-sm">
              <p className="flex items-center gap-2">
                <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                {health.progress?.operation === 'restore'
                  ? '正在校验并恢复素材…'
                  : '正在检查素材…'}
              </p>
              {health.progress && (
                <>
                  <progress
                    className="mt-3 h-1.5 w-full accent-primary"
                    value={health.progress.progress}
                    max={1}
                  />
                  {health.progress.assetName && (
                    <p className="mt-2 truncate text-xs text-muted-foreground">
                      {health.progress.assetName}
                    </p>
                  )}
                </>
              )}
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => void health.cancel()}
              >
                取消处理
              </Button>
            </div>
          )}
          {health.notice && (
            <p role="status" className="mt-4 text-sm text-muted-foreground">
              {health.notice}
            </p>
          )}
          {health.report && (
            <section className="mt-5">
              <p className="text-sm font-medium">
                {issues.length
                  ? `${issues.length} 个素材需要处理`
                  : health.report.mode === 'full'
                    ? '素材内容校验通过'
                    : '未发现缺失或大小异常的素材'}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                已检查 {health.report.assetCount} 个素材 ·{' '}
                {new Date(health.report.checkedAt).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {health.report.mode === 'quick'
                  ? '。这是文件位置与大小检查；此前发现的内容变化，需完整校验后才能确认恢复。'
                  : '。已逐一核对文件内容；此结果不代表所有媒体都能解码播放。'}
              </p>
              {issues.length > 0 && (
                <ul className="mt-4 divide-y rounded-lg border px-4">
                  {issues.map((issue) => (
                    <li key={issue.assetId} className="py-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-medium">
                            {issue.name}
                          </p>
                          <p className="mt-1 text-xs text-destructive">
                            {labels[issue.problem]}
                          </p>
                        </div>
                        {issue.problem === 'missing' && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={disabled || health.busy}
                            onClick={() => void health.restore(issue.assetId)}
                          >
                            <FolderSearch />
                            找到原文件
                          </Button>
                        )}
                      </div>
                      <p className="mt-2 break-words text-xs leading-5 text-muted-foreground">
                        {issue.message}
                      </p>
                      <p className="mt-1 break-all text-xs text-muted-foreground">
                        项目内位置：{issue.relativePath}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          <p className="mt-5 text-xs leading-5 text-muted-foreground">
            恢复会把内容一致的原文件复制回项目。已有文件不会被覆盖；内容已变化的文件，请先移出项目保留，点“重新检查位置”，再找到原文件恢复。
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={disabled || health.busy}
              onClick={() => void health.scan('quick')}
            >
              <RefreshCw />
              重新检查位置
            </Button>
            <Button
              disabled={disabled || health.busy}
              onClick={() => void health.scan('full')}
            >
              完整校验内容
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
