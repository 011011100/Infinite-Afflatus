import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type {
  WorkspaceDraftList,
  WorkspaceDraftRecord,
} from '../../../../shared/workspace-draft';
import { WorkspaceDraftQueue } from './workspace-draft-queue';

export function useWorkspaceDrafts(projectId: string) {
  const [queue] = useState(
    () =>
      new WorkspaceDraftQueue(projectId, crypto.randomUUID(), window.desktop),
  );
  const protection = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const [list, setList] = useState<WorkspaceDraftList>({
    drafts: [],
    issues: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++epoch.current;
    try {
      const found = await window.desktop.listWorkspaceDrafts(projectId);
      if (request === epoch.current) {
        setList({
          ...found,
          drafts: found.drafts.filter(
            (draft) => draft.sessionId !== queue.sessionId,
          ),
        });
        setError(null);
      }
    } catch {
      if (request === epoch.current)
        setError('暂时无法读取镜头恢复副本，原项目仍可使用。可重试检查。');
    }
  }, [projectId, queue]);
  useEffect(() => {
    void refresh();
    return () => {
      epoch.current++;
    };
  }, [refresh]);
  const exportDraft = async (record?: WorkspaceDraftRecord) => {
    const snapshot = queue.snapshot();
    const input = record
      ? { sessionId: record.sessionId, seq: record.seq }
      : snapshot
        ? { snapshot }
        : null;
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      const path = await window.desktop.exportWorkspaceDraft(projectId, input);
      if (path) setNotice(`只读镜头恢复文件已保存：${path}`);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message.replace(
              /^Error invoking remote method '[^']+': (Error: )?/,
              '',
            )
          : String(reason),
      );
    } finally {
      setBusy(false);
    }
  };
  return {
    queue,
    protection,
    ...list,
    error,
    setError,
    notice,
    busy,
    refresh,
    exportDraft,
  };
}
