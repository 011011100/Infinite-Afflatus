import { Archive, Copy, Download, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { flushPendingChanges } from '@/features/lifecycle/pending-saves';
import type { ProjectPackageInfo } from '../../../../shared/project-package';

function sizeLabel(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function ProjectPackageActions({
  projectId,
  projectName,
  disabled,
  report,
}: {
  projectId: string;
  projectName: string;
  disabled?: boolean;
  report: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const [info, setInfo] = useState<ProjectPackageInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  useEffect(() => {
    revision.current += 1;
    setInfo(null);
    setNotice(null);
    setError(null);
    setOpen(false);
    return () => {
      revision.current += 1;
    };
  }, []);
  const run = async (operation: () => Promise<string | null>) => {
    const current = revision.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (!(await flushPendingChanges()))
        throw new Error('还有修改未保存，请先重试保存。');
      const result = await operation();
      if (current === revision.current) setNotice(result);
    } catch (reason) {
      if (current === revision.current)
        setError(
          reason instanceof Error
            ? reason.message.replace(
                /^Error invoking remote method '[^']+': (Error: )?/,
                '',
              )
            : String(reason),
        );
      if (!openRef.current) report(reason);
    } finally {
      if (current === revision.current) setBusy(false);
    }
  };
  const inspect = () => {
    setOpen(true);
    void run(async () => {
      setInfo(await window.desktop.inspectProjectPackage(projectId));
      return null;
    });
  };
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={() => (busy ? setOpen(true) : inspect())}
      >
        {busy ? (
          <LoaderCircle className="animate-spin motion-reduce:animate-none" />
        ) : (
          <Archive />
        )}
        {busy ? '正在处理项目包' : '项目备份'}
      </Button>
      {open && (
        <Modal
          title="项目备份与副本"
          onClose={() => setOpen(false)}
          error={error}
        >
          <p className="truncate text-sm font-medium">{projectName}</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            项目包保留画布、镜头文本、生成参数和原始素材，可在另一台电脑导入后继续编辑。
          </p>
          {info && (
            <p className="mt-4 rounded-lg bg-muted p-3 text-sm">
              {info.assetCount} 个素材 · 预计 {sizeLabel(info.bytes)}
            </p>
          )}
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            备份不包含可重建缓存或应用设置。导入会创建独立项目，保留现有项目。请选择新的文件名，不覆盖已有备份。
          </p>
          {notice && (
            <p
              role="status"
              className="mt-4 break-all rounded-lg bg-primary/10 p-3 text-sm"
            >
              {notice}
            </p>
          )}
          {busy && (
            <p
              role="status"
              className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"
            >
              <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
              正在读取或复制项目，请稍候…
            </p>
          )}
          {busy && (
            <Button
              className="mt-3"
              variant="outline"
              size="sm"
              onClick={() =>
                void window.desktop.cancelProjectPackage().catch(report)
              }
            >
              取消处理
            </Button>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy || disabled || !info}
              onClick={() =>
                void run(async () => {
                  const copy = await window.desktop.duplicateProject(projectId);
                  return `已创建「${copy.project.name}」，可返回项目首页打开。`;
                })
              }
            >
              <Copy />
              创建副本
            </Button>
            <Button
              disabled={busy || disabled || !info}
              onClick={() =>
                void run(async () => {
                  const path =
                    await window.desktop.exportProjectPackage(projectId);
                  return path ? `项目包已保存：${path}` : null;
                })
              }
            >
              <Download />
              导出项目包
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
