import { ArchiveRestore, ArrowUpRight, Clapperboard, Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ProjectSummary } from '../../../../shared/models';

export function ProjectHome({
  projects,
  disabled,
  onCreate,
  onOpen,
  onImport,
  importingPackage = false,
  onCancelImport,
}: {
  projects: ProjectSummary[];
  disabled: boolean;
  onCreate: (name: string) => Promise<void>;
  onOpen: (id: string) => Promise<void>;
  onImport: () => Promise<void>;
  importingPackage?: boolean;
  onCancelImport: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  return (
    <main className="flex-1 overflow-auto px-10 py-16">
      <div className="mx-auto max-w-4xl">
        <p className="mb-3 text-xs tracking-[0.22em] text-muted-foreground">
          INFINITE AFFLATUS
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          你的创作，从这里继续
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          每个项目都有自己的画布，素材与进度保存在本机。
        </p>
        <form
          className="mt-9 flex max-w-xl gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void onCreate(name.trim() || '未命名项目');
          }}
        >
          <Input
            aria-label="新项目名称"
            placeholder="给新项目起个名字"
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            disabled={disabled}
          />
          <Button type="submit" className="h-10 shrink-0" disabled={disabled}>
            <Plus />
            新建项目
          </Button>
        </form>
        <div className="mt-14 flex items-center justify-between border-b pb-3">
          <h2 className="text-sm font-medium">我的项目</h2>
          <div className="flex items-center gap-4">
            <span className="text-xs text-muted-foreground">
              {projects.length} 个项目
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => void onImport()}
            >
              <ArchiveRestore />
              导入项目包
            </Button>
          </div>
        </div>
        {importingPackage && (
          <div
            className="mt-4 flex items-center gap-3 rounded-lg border bg-background p-3 text-sm"
            role="status"
          >
            <span>正在读取项目包并复制素材…</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void onCancelImport()}
            >
              取消导入
            </Button>
          </div>
        )}
        {projects.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            还没有项目。创建后，随时可以回来继续。
          </div>
        ) : (
          <ul className="divide-y">
            {projects.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    void onOpen(project.id);
                  }}
                  className="group flex w-full items-center gap-4 rounded-lg px-3 py-5 text-left transition-colors hover:bg-background focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                >
                  <span className="flex size-11 items-center justify-center rounded-lg border bg-background text-primary">
                    <Clapperboard size={20} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {project.name}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {new Date(project.updatedAt).toLocaleString('zh-CN', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </span>
                  </span>
                  <ArrowUpRight
                    size={16}
                    className="text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
