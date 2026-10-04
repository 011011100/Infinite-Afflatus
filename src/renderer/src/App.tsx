import { ArrowLeft, Settings2, Upload, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useContentMotion } from '@/components/ui/use-surface-motion';
import { ProjectEditDraftNotice } from '@/features/drafts/project-edit-draft-notice';
import { projectEditRecoveryGuards } from '@/features/drafts/project-edit-recovery-guards';
import { useProjectEditDrafts } from '@/features/drafts/use-project-edit-drafts';
import { ExportTaskButton } from '@/features/export/export-dialog';
import { SaveLifecycleStatus } from '@/features/lifecycle/save-lifecycle-status';
import { useSaveLifecycle } from '@/features/lifecycle/use-save-lifecycle';
import { ProjectHealthButton } from '@/features/projects/project-health';
import { ProjectHome } from '@/features/projects/project-home';
import { ProjectPackageActions } from '@/features/projects/project-package-actions';
import { ProjectRenameDialog } from '@/features/projects/project-rename-dialog';
import { ProjectUnavailableNotice } from '@/features/projects/project-unavailable-notice';
import { useLibrary } from '@/features/projects/use-library';
import { useProjectRename } from '@/features/projects/use-project-rename';
import { AppSettings } from '@/features/settings/app-settings';
import { SaveStatus } from '@/features/settings/save-status';
import { CanvasErrorBoundary } from '@/features/workspace/canvas-error-boundary';
import { ProjectCanvas } from '@/features/workspace/project-canvas';
import { useInputMethod } from '@/lib/input-method';
import type { ProjectSnapshot } from '../../shared/models';
import type { ProjectEditDraftRecord } from '../../shared/project-edit-draft';

export function App() {
  useInputMethod();
  const state = useLibrary();
  const lifecycle = useSaveLifecycle();
  const [settings, setSettings] = useState(false);
  const [settingsPage, setSettingsPage] = useState<'interactions' | 'storage'>(
    'interactions',
  );
  const { library, project, busy, run, refreshProjectAfterEdit } = state;
  const baseProjectBlocked =
    library?.writeBlocked === true || !!state.projectUnavailable;
  const onRestored = useCallback(
    async (_record: ProjectEditDraftRecord, saved: ProjectSnapshot) => {
      await refreshProjectAfterEdit(saved);
    },
    [refreshProjectAfterEdit],
  );
  const editRecovery = useProjectEditDrafts(
    project?.project.id ?? null,
    baseProjectBlocked,
    onRestored,
  );
  const projectBlocked = baseProjectBlocked || editRecovery.restoring;
  const rename = useProjectRename(project, {
    blocked: projectBlocked,
    onSaved: refreshProjectAfterEdit,
    onDraftsChanged: editRecovery.refresh,
  });
  const editNotice = project ? (
    <ProjectEditDraftNotice
      recovery={editRecovery}
      snapshot={project}
      blocked={projectBlocked}
      activeNameSession={rename.editor?.sessionId ?? null}
      nameEditing={!!rename.editor}
      openName={(record) => {
        if (projectEditRecoveryGuards.canRecover(project.project.id))
          rename.open(record);
      }}
    />
  ) : null;
  const unavailableNotice = state.projectUnavailable ? (
    <ProjectUnavailableNotice
      state={state.projectUnavailable}
      retry={state.retryProject}
      migrating={library?.writeBlocked === true}
      openSettings={() => {
        setSettingsPage('storage');
        setSettings(true);
      }}
    />
  ) : undefined;
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
              disabled={projectBlocked}
              className="max-w-96 truncate rounded px-1 py-2 text-sm font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
              title="修改项目名称"
              onClick={() => rename.open()}
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
            <ProjectHealthButton
              key={`health:${project.project.id}`}
              projectId={project.project.id}
              disabled={busy || projectBlocked || lifecycle.saving}
            />
          )}
          {project && (
            <ProjectPackageActions
              key={project.project.id}
              projectId={project.project.id}
              projectName={project.project.name}
              disabled={busy || projectBlocked}
              report={state.report}
            />
          )}
          {project && (
            <Button
              variant="outline"
              disabled={busy || projectBlocked}
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
            onClick={() => {
              setSettingsPage('interactions');
              setSettings(true);
            }}
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
          restartRequired={library.migration?.restartRequired}
          run={run}
          blockedProjectId={state.projectUnavailable?.projectId}
          onManageStaging={() => {
            setSettingsPage('storage');
            setSettings(true);
          }}
        />
      )}
      {unavailableNotice}
      {editNotice}
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
              blocked={projectBlocked}
              projectUnavailable={!!state.projectUnavailable}
              unavailableNotice={
                <>
                  {unavailableNotice}
                  {editNotice}
                </>
              }
              interactions={library.interactions}
              inactive={settings || !!rename.editor || lifecycle.saving}
              report={state.reportProjectFailure}
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
          currentProjectId={project?.project.id ?? null}
          error={state.error}
          run={run}
          beforeMigration={() => lifecycle.prepare()}
          initialPage={settingsPage}
          onClose={() => setSettings(false)}
        />
      )}
      <ProjectRenameDialog
        rename={rename}
        unavailableNotice={unavailableNotice}
      />
    </div>
  );
}
