import { ArrowLeft, Settings2, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { useContentMotion } from '@/components/ui/use-surface-motion';
import { ExportTaskButton } from '@/features/export/export-dialog';
import { SaveLifecycleStatus } from '@/features/lifecycle/save-lifecycle-status';
import { useSaveLifecycle } from '@/features/lifecycle/use-save-lifecycle';
import { ProjectHome } from '@/features/projects/project-home';
import { ProjectPackageActions } from '@/features/projects/project-package-actions';
import { useLibrary } from '@/features/projects/use-library';
import { AppSettings } from '@/features/settings/app-settings';
import { SaveStatus } from '@/features/settings/save-status';
import { CanvasErrorBoundary } from '@/features/workspace/canvas-error-boundary';
import { ProjectCanvas } from '@/features/workspace/project-canvas';
import { useInputMethod } from '@/lib/input-method';

export function App() {
  useInputMethod();
  const state = useLibrary();
  const lifecycle = useSaveLifecycle();
  const [settings, setSettings] = useState(false);
  const [newName, setNewName] = useState<string | null>(null);
  const { library, project, busy, run } = state;
  const content = useRef<HTMLDivElement>(null);
  useContentMotion(
    content,
    !library ? 'loading' : (project?.project.id ?? 'home'),
  );
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b bg-background px-6 select-none">
        {project ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="返回项目首页"
              disabled={lifecycle.saving}
              onClick={() => {
                void lifecycle.prepare().then((saved) => {
                  if (saved) state.home();
                });
              }}
            >
              <ArrowLeft />
            </Button>
            <button
              type="button"
              disabled={library?.writeBlocked}
              className="max-w-96 truncate rounded px-1 py-2 text-sm font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
              title="修改项目名称"
              onClick={() => setNewName(project.project.name)}
            >
              {project.project.name}
            </button>
            <span className="text-xs text-muted-foreground">本地项目</span>
          </>
        ) : (
          <span className="text-[15px] font-semibold tracking-tight">
            Infinite Afflatus
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <ExportTaskButton />
          {project && (
            <ProjectPackageActions
              key={project.project.id}
              projectId={project.project.id}
              projectName={project.project.name}
              disabled={busy || library?.writeBlocked === true}
              report={state.report}
            />
          )}
          {project && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                void run(() => window.desktop.importVideos(project.project.id));
              }}
            >
              <Upload />
              导入视频
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label="设置"
            disabled={!library}
            onClick={() => setSettings(true)}
          >
            <Settings2 />
          </Button>
        </div>
      </header>
      {state.error && (
        <div
          className="flex items-center gap-3 bg-warning px-6 py-2.5 text-sm text-warning-foreground"
          role="alert"
        >
          <span className="min-w-0 flex-1 break-words">{state.error}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="关闭提示"
            onClick={state.clearError}
          >
            <X />
          </Button>
        </div>
      )}
      {library && (
        <SaveStatus
          jobs={library.jobs}
          migrating={library.writeBlocked}
          run={run}
        />
      )}
      <div ref={content} className="flex min-h-0 flex-1 flex-col">
        {!library ? (
          <main className="grid flex-1 place-items-center text-sm text-muted-foreground">
            {state.error ? '项目库尚未打开' : '正在打开项目库…'}
          </main>
        ) : project ? (
          <CanvasErrorBoundary
            key={`canvas:${project.project.id}`}
            onHome={state.home}
          >
            <ProjectCanvas
              snapshot={project}
              blocked={library.writeBlocked}
              interactions={library.interactions}
              inactive={settings || newName !== null || lifecycle.saving}
              report={state.report}
            />
          </CanvasErrorBoundary>
        ) : (
          <ProjectHome
            projects={library.projects}
            disabled={busy || library.writeBlocked}
            onCreate={state.create}
            onOpen={state.open}
            onImport={state.importPackage}
            importingPackage={state.importingPackage}
            onCancelImport={state.cancelPackage}
          />
        )}
      </div>
      <SaveLifecycleStatus {...lifecycle} />
      {settings && library && (
        <AppSettings
          library={library}
          error={state.error}
          run={async (operation) => {
            if (await lifecycle.prepare()) await run(operation);
          }}
          onClose={() => setSettings(false)}
        />
      )}
      {newName !== null && project && (
        <Modal
          title="修改项目名称"
          onClose={() => setNewName(null)}
          error={state.error}
        >
          {(requestClose) => (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  await window.desktop.renameProject(
                    project.project.id,
                    newName,
                  );
                  requestClose();
                });
              }}
            >
              <Input
                aria-label="项目名称"
                value={newName}
                maxLength={100}
                onChange={(event) => setNewName(event.target.value)}
              />
              <div className="mt-5 flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={requestClose}>
                  取消
                </Button>
                <Button
                  type="submit"
                  disabled={busy || !newName.trim() || library?.writeBlocked}
                >
                  保存
                </Button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}
