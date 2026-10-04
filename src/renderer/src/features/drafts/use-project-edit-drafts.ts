import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ProjectSnapshot } from '../../../../shared/models';
import type {
  ProjectEditDraftExport,
  ProjectEditDraftList,
  ProjectEditDraftRecord,
} from '../../../../shared/project-edit-draft';
import { usePendingSave } from '../lifecycle/use-pending-save';
import { projectErrorMessage } from '../projects/library-session';
import {
  type ProjectEditRecoveryAttempt,
  projectEditRecoveryGuards,
} from './project-edit-recovery-guards';

const empty = (): ProjectEditDraftList => ({ drafts: [], issues: [] });

/** List and explicitly recover independent edits; never flush live input to make recovery eligible. */
export function useProjectEditDrafts(
  projectId: string | null,
  blocked: boolean,
  onRestored: (
    record: ProjectEditDraftRecord,
    snapshot: ProjectSnapshot,
  ) => Promise<void>,
) {
  const [list, setList] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const epoch = useRef(0);
  const context = useRef({ projectId, version: 0 });
  if (context.current.projectId !== projectId)
    context.current = { projectId, version: context.current.version + 1 };
  const current = useRef({ projectId, blocked, onRestored });
  current.current = { projectId, blocked, onRestored };
  const pending = useRef<Promise<boolean> | null>(null);
  const recovering = useSyncExternalStore(
    projectEditRecoveryGuards.subscribe,
    () => !!projectId && projectEditRecoveryGuards.isRecovering(projectId),
  );
  const canRecover = useSyncExternalStore(
    projectEditRecoveryGuards.subscribe,
    () => !!projectId && projectEditRecoveryGuards.canRecover(projectId),
  );
  usePendingSave(
    '项目编辑恢复',
    () => pending.current ?? Promise.resolve(true),
    -40,
    () => pending.current,
  );

  const refresh = useCallback(async () => {
    if (current.current.projectId !== projectId) return;
    const version = context.current.version;
    const request = ++epoch.current;
    if (!projectId) {
      setList(empty());
      return;
    }
    try {
      const found = await window.desktop.listProjectEditDrafts(projectId);
      if (
        request === epoch.current &&
        context.current.version === version &&
        current.current.projectId === projectId
      ) {
        setList(found);
        setError(null);
      }
    } catch (reason) {
      if (
        request === epoch.current &&
        context.current.version === version &&
        current.current.projectId === projectId
      )
        setError(`无法读取项目编辑恢复副本：${projectErrorMessage(reason)}`);
    }
  }, [projectId]);

  useEffect(() => {
    setList(empty());
    setError(null);
    setNotice(null);
    void refresh();
    return () => {
      epoch.current++;
      context.current.version++;
    };
  }, [refresh]);

  const perform = (
    operation: (id: string, isCurrent: () => boolean) => Promise<void>,
  ) => {
    const id = current.current.projectId;
    if (!id || pending.current) return Promise.resolve(false);
    const version = context.current.version;
    const isCurrent = () =>
      current.current.projectId === id && context.current.version === version;
    setBusy(true);
    setError(null);
    // Acquire the recovery lock before any stale same-turn handler can edit.
    const task = operation(id, isCurrent)
      .then(() => true)
      .catch((reason: unknown) => {
        if (isCurrent()) setError(projectErrorMessage(reason));
        return false;
      })
      .finally(() => {
        if (pending.current === task) {
          pending.current = null;
          setBusy(false);
          setRestoring(false);
        }
      });
    pending.current = task;
    return task;
  };

  const recover = (record: ProjectEditDraftRecord) =>
    perform(async (id, isCurrent) => {
      if (current.current.blocked || record.project.id !== id)
        throw new Error('项目当前不可写，请先恢复原项目位置后再试。');
      const release = projectEditRecoveryGuards.begin(id);
      setRestoring(true);
      let committed = false;
      let attempt: ProjectEditRecoveryAttempt | undefined;
      try {
        attempt = projectEditRecoveryGuards.prepare(record);
        const snapshot = await window.desktop.recoverProjectEditDraft(id, {
          sessionId: record.sessionId,
          seq: record.seq,
        });
        committed = true;
        if (!isCurrent()) return;
        projectEditRecoveryGuards.accept(record, snapshot);
        attempt.complete();
        await current.current.onRestored(record, snapshot);
        if (!isCurrent()) return;
        await refresh();
        if (isCurrent())
          setNotice(
            record.kind === 'trim'
              ? '裁剪修改已恢复并保存，源视频未改动。'
              : '项目名称已保存。',
          );
      } catch (reason) {
        // Freeze against the captured full baseline before releasing the lock:
        // a native change notification can arrive even when its reply is lost.
        if (!committed && isCurrent()) attempt?.failed(reason);
        // The write may be complete even when updating the current view failed.
        // Do not keep offering a record that the native transaction acknowledged.
        if (committed && isCurrent()) await refresh();
        throw reason;
      } finally {
        attempt?.complete();
        release();
      }
    });

  const acknowledge = (record: ProjectEditDraftRecord) =>
    perform(async (id, isCurrent) => {
      if (current.current.blocked || record.project.id !== id)
        throw new Error('项目当前不可用，请恢复后再确认已保存的修改。');
      const release = projectEditRecoveryGuards.begin(id);
      try {
        if (
          !(await window.desktop.acknowledgeProjectEditDraft(id, {
            sessionId: record.sessionId,
            seq: record.seq,
          }))
        )
          throw new Error('恢复副本或已保存内容已经变化，请重新检查。');
        if (!isCurrent()) return;
        await refresh();
        if (isCurrent()) setNotice('已核对保存内容并清理对应恢复副本。');
      } finally {
        release();
      }
    });

  const exportDraft = (input: ProjectEditDraftExport) =>
    perform(async (id, isCurrent) => {
      const path = await window.desktop.exportProjectEditDraft(id, input);
      if (path && isCurrent()) setNotice(`只读编辑恢复文件已保存：${path}`);
    });

  return {
    ...list,
    error,
    notice,
    busy,
    canRecover,
    restoring: restoring || recovering,
    refresh,
    recover,
    acknowledge,
    exportDraft,
    dismissNotice: () => setNotice(null),
  };
}
