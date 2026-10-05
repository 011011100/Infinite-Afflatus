import { Archive, Copy, Download, LoaderCircle } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import type { ProjectPackageInfo } from '../../../../shared/project-package';
import {
  ProjectPackageStatus,
  packageSizeLabel,
} from './project-package-status';
import { useProjectPackageOperation } from './use-project-package-operation';

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
  const operation = useProjectPackageOperation((reason) => {
    if (!openRef.current) report(reason);
  });
  const { busy } = operation;
  const inspect = () => {
    setOpen(true);
    void operation.run(
      (requestId) => window.desktop.inspectProjectPackage(projectId, requestId),
      (value) => {
        setInfo(value);
        return null;
      },
    );
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
          error={operation.error}
        >
          <p className="truncate text-sm font-medium">{projectName}</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            项目包保留画布、镜头文本、生成参数和原始素材，可在另一台电脑导入后继续编辑。
          </p>
          {info && (
            <p className="mt-4 rounded-lg bg-muted p-3 text-sm">
              {info.assetCount} 个素材 · 预计 {packageSizeLabel(info.bytes)}
            </p>
          )}
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            备份不包含可重建缓存或应用设置。导入会创建独立项目，保留现有项目。请选择新的文件名，不覆盖已有备份。
          </p>
          <ProjectPackageStatus operation={operation} />
          <div className="mt-6 flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy || disabled || !info}
              onClick={() =>
                void operation.run(
                  (requestId) =>
                    window.desktop.duplicateProject(projectId, requestId),
                  (copy) =>
                    `已创建「${copy.project.name}」，可返回项目首页打开。`,
                )
              }
            >
              <Copy />
              创建副本
            </Button>
            <Button
              disabled={busy || disabled || !info}
              onClick={() =>
                void operation.run(
                  (requestId) =>
                    window.desktop.exportProjectPackage(projectId, requestId),
                  (path) => `项目包已保存：${path}`,
                )
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
