import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ProjectSnapshot } from '../../../../shared/models';
import type { ProjectEditDraftRecord } from '../../../../shared/project-edit-draft';
import { projectEditRecoveryGuards } from '../drafts/project-edit-recovery-guards';
import { usePendingSave } from '../lifecycle/use-pending-save';
import { projectErrorMessage } from './library-session';
import { ProjectRenameSession } from './project-rename-session';

const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

export function useProjectRename(
  project: ProjectSnapshot | null,
  options: {
    blocked: boolean;
    onSaved: (snapshot: ProjectSnapshot) => Promise<void>;
    onDraftsChanged: () => void | Promise<void>;
  },
) {
  const [session, setSession] = useState<ProjectRenameSession | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const active = useRef<ProjectRenameSession | null>(null);
  const latest = useRef({ project, options });
  latest.current = { project, options };
  const mounted = useRef(false);
  const epoch = useRef(0);
  const state = useSyncExternalStore(
    session?.subscribe ?? emptySubscribe,
    session?.getSnapshot ?? emptySnapshot,
  );
  const projectId = project?.project.id;
  const recovering = useSyncExternalStore(
    projectEditRecoveryGuards.subscribe,
    () =>
      projectId ? projectEditRecoveryGuards.isRecovering(projectId) : false,
  );

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, []);
  useLayoutEffect(() => {
    if (active.current && active.current.project.id !== projectId) {
      // A forced context change keeps its independent recovery stream. A late
      // reply must never close a newer editor or refresh a different project.
      active.current = null;
      setSession(null);
      epoch.current++;
    }
    if (!projectId) return;
    return projectEditRecoveryGuards.register(
      projectId,
      () =>
        !active.current ||
        (active.current.isFinished() && !active.current.pending()),
    );
  }, [projectId]);
  useLayoutEffect(
    () => session?.subscribe(() => projectEditRecoveryGuards.notify()),
    [session],
  );

  usePendingSave(
    '项目名称输入',
    async () => {
      const editor = active.current;
      if (!editor) return true;
      const current = latest.current.project;
      if (!current || editor.project.id !== current.project.id) return false;
      const ready = await editor.leave(current.project.name);
      if (ready) await latest.current.options.onDraftsChanged();
      return ready;
    },
    -20,
    () => active.current?.pending() ?? null,
  );

  const open = (record?: ProjectEditDraftRecord) => {
    const { project: current, options: config } = latest.current;
    if (
      !current ||
      config.blocked ||
      active.current ||
      projectEditRecoveryGuards.isRecovering(current.project.id)
    )
      return false;
    try {
      if (record && record.kind !== 'name')
        throw new Error('此恢复副本不是项目名称。');
      const next = new ProjectRenameSession(
        current.project,
        window.desktop,
        record,
      );
      active.current = next;
      epoch.current++;
      setOpenError(null);
      setSession(next);
      projectEditRecoveryGuards.notify();
      return true;
    } catch (error) {
      setOpenError(projectErrorMessage(error));
      return false;
    }
  };
  const isCurrent = (editor: ProjectRenameSession, request: number) =>
    mounted.current && epoch.current === request && active.current === editor;
  const save = async () => {
    const editor = active.current;
    const { project: current, options: config } = latest.current;
    if (
      !editor ||
      !current ||
      config.blocked ||
      projectEditRecoveryGuards.isRecovering(current.project.id) ||
      !editor.canSave(current.project.name)
    )
      return false;
    const request = epoch.current;
    const saved = await editor.save(async (snapshot) => {
      if (!isCurrent(editor, request)) return;
      await latest.current.options.onSaved(snapshot);
      if (isCurrent(editor, request))
        await latest.current.options.onDraftsChanged();
    });
    return saved && isCurrent(editor, request);
  };
  const beforeClose = async () => {
    const editor = active.current;
    if (!editor) return true;
    if (editor.pending()) return false;
    const request = epoch.current;
    const closed = await editor.cancel();
    if (!isCurrent(editor, request)) return false;
    if (closed) {
      try {
        await latest.current.options.onDraftsChanged();
      } catch (error) {
        if (isCurrent(editor, request))
          setOpenError(projectErrorMessage(error));
        return false;
      }
    }
    return closed && isCurrent(editor, request);
  };
  const close = useCallback(() => {
    if (!active.current?.isFinished()) return;
    active.current = null;
    epoch.current++;
    setSession(null);
    projectEditRecoveryGuards.notify();
  }, []);

  return {
    editor:
      session && state ? { ...state, sessionId: session.sessionId } : null,
    open,
    save,
    beforeClose,
    close,
    setValue: (value: string) => {
      const { project: current, options: config } = latest.current;
      if (
        config.blocked ||
        !current ||
        projectEditRecoveryGuards.isRecovering(current.project.id)
      )
        return;
      active.current?.setTarget(value);
    },
    exportDraft: () => active.current?.exportDraft() ?? Promise.resolve(false),
    retryProtection: () =>
      active.current?.flushProtection() ?? Promise.resolve(true),
    busy: !!state?.busy,
    saved: !!session?.hasSaved(),
    canSave:
      !options.blocked &&
      !recovering &&
      !state?.busy &&
      !!session &&
      !!project &&
      session.canSave(project.project.name),
    readOnly:
      options.blocked || recovering || !!state?.busy || !!session?.isFinished(),
    conflict: !!session && !!project && !session.canSave(project.project.name),
    error: state?.error ?? openError,
    protectionError: state?.protectionError ?? null,
  };
}
