import { useCallback, useEffect, useRef, useState } from 'react';
import {
  duplicateShot,
  MAX_SHOTS,
} from '../../../../shared/generation/shot-duplication';
import {
  type ShotEditOptions,
  ShotHistory,
  type ShotHistoryActions,
} from '../../../../shared/generation/shot-history';
import {
  type GenerationWorkspace,
  newShot,
  type Point,
  type ShotWorkspace,
} from '../../../../shared/generation/workspace';
import type { Asset } from '../../../../shared/models';
import type { WorkspaceDraftRecord } from '../../../../shared/workspace-draft';
import { useWorkspaceDrafts } from '../drafts/use-workspace-drafts';
import { usePendingSave } from '../lifecycle/use-pending-save';
import { useProjectRecoveryGuard } from '../projects/use-project-recovery-guard';
import { message } from './errors';
import type { ReferenceImportTarget } from './reference-import-target';

/** One project-scoped save stream, including edits made while an earlier write is pending. */
export function useShotWorkspace(
  projectId: string,
  blocked: boolean,
  report?: (reason: unknown) => void,
) {
  const [workspace, setWorkspace] = useState<GenerationWorkspace | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedEdit, setSavedEdit] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const recoveringRef = useRef(false);
  const isRecovering = useCallback(() => recoveringRef.current, []);
  const recovery = useWorkspaceDrafts(projectId);
  const draftQueue = recovery.queue;
  const current = useRef<GenerationWorkspace | null>(null);
  const confirmed = useRef<GenerationWorkspace | null>(null);
  const reportError = useRef(report);
  reportError.current = report;
  const edit = useRef(0);
  const saved = useRef(0);
  const pending = useRef<Promise<boolean> | null>(null);
  const locked = useRef(blocked);
  const history = useRef(new ShotHistory());
  const imports = useRef(new Set<symbol>());
  // Keep a staged copy's identity across save failures. Retrying opens that copy,
  // even when the ordinary save timer has since persisted it successfully.
  const copyCandidates = useRef(new Map<string, string>());
  const copying = useRef<Promise<ShotWorkspace | null> | null>(null);
  locked.current = blocked || recoveringRef.current;
  const flush = useCallback((): Promise<boolean> => {
    if (pending.current) return pending.current;
    if (!current.current || edit.current === saved.current)
      return Promise.resolve(true);
    if (locked.current) return Promise.resolve(false);
    setSaving(true);
    pending.current = (async () => {
      try {
        while (current.current && saved.current !== edit.current) {
          if (locked.current) return false;
          const version = edit.current;
          const submitted = current.current;
          draftQueue.prepareSubmission(
            confirmed.current ?? submitted,
            submitted,
          );
          // A recovery write failure is visible but must not prevent the normal
          // project transaction from saving the user's work.
          await draftQueue.flush();
          if (locked.current) return false;
          const result = await window.desktop.saveGenerationWorkspace(
            projectId,
            submitted,
          );
          confirmed.current = result;
          current.current = { ...current.current, revision: result.revision };
          saved.current = version;
          setSavedEdit(version);
          const settled = draftQueue.confirm(result, current.current);
          await draftQueue.flush();
          if (saved.current === edit.current)
            await draftQueue.acknowledge(settled);
        }
        setError(null);
        return true;
      } catch (reason) {
        setError(message(reason));
        reportError.current?.(reason);
        return false;
      } finally {
        pending.current = null;
        setSaving(false);
      }
    })();
    return pending.current;
  }, [projectId, draftQueue]);
  usePendingSave(
    `镜头草稿:${projectId}`,
    () => copying.current?.then(Boolean) ?? flush(),
    0,
    () => copying.current?.then(Boolean) ?? pending.current,
  );
  useProjectRecoveryGuard(projectId, async () => {
    await pending.current;
    const remote = await window.desktop.getGenerationWorkspace(projectId);
    if (
      confirmed.current &&
      JSON.stringify(remote) !== JSON.stringify(confirmed.current)
    )
      return '磁盘上的镜头草稿与本页最后确认的版本不同。当前输入和撤销记录仍保留，请先恢复原项目文件；未自动覆盖或合并。';
    if (!current.current) {
      current.current = remote;
      confirmed.current = remote;
      setWorkspace(remote);
    }
    return null;
  });
  useEffect(() => {
    let active = true;
    void window.desktop
      .getGenerationWorkspace(projectId)
      .then((value) => {
        if (active) {
          current.current = value;
          confirmed.current = value;
          setWorkspace(value);
        }
      })
      .catch((reason) => {
        if (active) {
          setError(message(reason));
          reportError.current?.(reason);
        }
      });
    return () => {
      active = false;
      void flush();
    };
  }, [projectId, flush]);
  const commit = useCallback(
    (next: GenerationWorkspace) => {
      if (next === current.current) return;
      current.current = next;
      edit.current += 1;
      if (confirmed.current) draftQueue.stage(confirmed.current, next);
      setWorkspace(next);
    },
    [draftQueue],
  );
  const change = useCallback(
    (update: (value: GenerationWorkspace) => GenerationWorkspace) => {
      if (!current.current || locked.current) return;
      commit(update(current.current));
    },
    [commit],
  );
  const beginReferenceImport = (
    shotId: string,
  ): ReferenceImportTarget | null => {
    if (
      locked.current ||
      !current.current?.shots.some((shot) => shot.id === shotId)
    )
      return null;
    const token = Symbol('shot-reference-import');
    imports.current.add(token);
    return {
      append: (nodes) => {
        const doc = current.current;
        const shot = doc?.shots.find((item) => item.id === shotId);
        if (
          !imports.current.has(token) ||
          recoveringRef.current ||
          !doc ||
          !shot
        )
          return false;
        // A retry uses the same IDs and cannot append the same result twice.
        const existing = new Map(shot.nodes.map((node) => [node.id, node]));
        const added = [];
        for (const node of nodes) {
          const previous = existing.get(node.id);
          if (previous) {
            if (previous.type !== 'asset' || previous.assetId !== node.assetId)
              return false;
            continue;
          }
          const next = {
            id: node.id,
            assetId: node.assetId,
            position: node.position,
            type: 'asset' as const,
          };
          existing.set(node.id, next);
          added.push(next);
        }
        if (!added.length) return true;
        const next = { ...shot, nodes: [...shot.nodes, ...added] };
        history.current.record(shot, next);
        // This is only completion of work authorized before the lock. Ordinary
        // edits stay blocked; the independent recovery journal protects its IDs.
        commit({
          ...doc,
          shots: doc.shots.map((item) => (item.id === shotId ? next : item)),
        });
        return true;
      },
      finish: () => {
        imports.current.delete(token);
      },
    };
  };
  useEffect(() => {
    if (!workspace || blocked || saved.current === edit.current) return;
    const timer = setTimeout(() => {
      void flush();
    }, 350);
    return () => clearTimeout(timer);
  }, [workspace, blocked, flush]);
  const loaded = !!workspace;
  useEffect(() => {
    if (!loaded || blocked) return;
    const timer = setInterval(() => {
      void flush();
    }, 1000);
    return () => clearInterval(timer);
  }, [loaded, blocked, flush]);
  const recoverDraft = async (record: WorkspaceDraftRecord) => {
    if (imports.current.size) {
      recovery.setError('素材导入尚未结束，请完成或取消后再恢复镜头草稿。');
      return false;
    }
    if (
      !current.current ||
      locked.current ||
      edit.current !== saved.current ||
      pending.current ||
      copying.current
    )
      return false;
    recoveringRef.current = true;
    locked.current = true;
    setRecovering(true);
    pending.current = (async () => {
      try {
        const value = await window.desktop.recoverWorkspaceDraft(projectId, {
          sessionId: record.sessionId,
          seq: record.seq,
        });
        confirmed.current = value;
        current.current = value;
        history.current = new ShotHistory();
        copyCandidates.current.clear();
        setActiveId((id) =>
          id && value.shots.some((shot) => shot.id === id) ? id : null,
        );
        setWorkspace(value);
        setError(null);
        await recovery.refresh();
        return true;
      } catch (reason) {
        await recovery.refresh();
        recovery.setError(message(reason));
        return false;
      } finally {
        recoveringRef.current = false;
        pending.current = null;
        setRecovering(false);
      }
    })();
    return pending.current;
  };
  const updateShot = useCallback(
    (
      id: string,
      update: (shot: ShotWorkspace) => ShotWorkspace,
      options?: ShotEditOptions,
    ) => {
      change((doc) => {
        let changed = false;
        const shots = doc.shots.map((shot) => {
          if (shot.id !== id) return shot;
          const next = update(shot);
          if (next === shot || JSON.stringify(next) === JSON.stringify(shot))
            return shot;
          history.current.record(shot, next, options);
          changed = true;
          return next;
        });
        return changed ? { ...doc, shots } : doc;
      });
    },
    [change],
  );
  const restore = (id: string, direction: 'undo' | 'redo') => {
    change((doc) => {
      let changed = false;
      const shots = doc.shots.map((shot) => {
        if (shot.id !== id) return shot;
        const next = history.current[direction](shot);
        changed ||= next !== shot;
        return next;
      });
      return changed ? { ...doc, shots } : doc;
    });
  };
  const open = (id: string | null) => {
    // A stale card callback can run in the same event turn as recovery begins,
    // before React has rendered disabled controls. Do not queue a late switch.
    if (
      recoveringRef.current ||
      (id && !current.current?.shots.some((shot) => shot.id === id))
    )
      return;
    if (activeId) history.current.breakMerge(activeId);
    if (id) history.current.breakMerge(id);
    setActiveId(id);
  };
  const create = (position: Point, asset?: Asset) => {
    if (!current.current || locked.current) return;
    const existing =
      asset &&
      current.current.shots.find((shot) => shot.sourceAssetId === asset.id);
    if (existing) {
      open(existing.id);
      return;
    }
    if (current.current.shots.length >= MAX_SHOTS) {
      setError(`项目最多容纳 ${MAX_SHOTS} 个镜头，请在新项目中继续创作。`);
      return;
    }
    const id = crypto.randomUUID();
    change((doc) => ({
      ...doc,
      shots: [
        ...doc.shots,
        newShot(
          id,
          asset?.name.slice(0, 100) ??
            `镜头 ${String(doc.shots.length + 1).padStart(2, '0')}`,
          position,
          asset?.id,
        ),
      ],
    }));
    open(id);
  };
  const duplicate = (sourceId: string, position: Point) => {
    if (copying.current) return copying.current;
    copying.current = (async () => {
      if (locked.current || !current.current) return null;
      if (imports.current.size)
        throw new Error('请完成或取消素材导入后再复制镜头。');
      if (!(await flush()) || locked.current) return null;
      const doc = current.current;
      const source = doc.shots.find((shot) => shot.id === sourceId);
      if (!source) throw new Error('原镜头已不可用，请返回主画布后重试。');
      const candidateId = copyCandidates.current.get(sourceId);
      let copy = doc.shots.find((shot) => shot.id === candidateId);
      if (!copy) {
        copy = duplicateShot(source, doc.shots, position);
        copyCandidates.current.set(sourceId, copy.id);
        history.current.breakMerge(sourceId);
        commit({ ...doc, shots: [...doc.shots, copy] });
      }
      // A failed write leaves the original view and both drafts available. Never
      // manufacture another copy to retry the same user's operation.
      if (!(await flush()) || locked.current) return null;
      copyCandidates.current.delete(sourceId);
      open(copy.id);
      return copy;
    })().finally(() => {
      copying.current = null;
    });
    return copying.current;
  };
  return {
    shots: workspace?.shots ?? [],
    recovery,
    recoverDraft,
    recovering,
    isRecovering,
    baseline: confirmed.current,
    dirty: edit.current !== saved.current,
    loaded: !!workspace,
    saving: saving || savedEdit !== edit.current,
    error,
    setError,
    activeShot: workspace?.shots.find((shot) => shot.id === activeId),
    activeId,
    open,
    create,
    duplicate,
    duplicatePending: !!activeId && copyCandidates.current.has(activeId),
    updateShot,
    beginReferenceImport,
    historyFor: (id: string): ShotHistoryActions => ({
      ...history.current.state(id),
      undo: () => restore(id, 'undo'),
      redo: () => restore(id, 'redo'),
      breakMerge: () => history.current.breakMerge(id),
    }),
    flush,
    retry: async () => {
      if (current.current) return flush();
      try {
        const loaded = await window.desktop.getGenerationWorkspace(projectId);
        current.current = loaded;
        confirmed.current = loaded;
        setWorkspace(loaded);
        setError(null);
        return true;
      } catch (reason) {
        setError(message(reason));
        reportError.current?.(reason);
        return false;
      }
    },
    dismiss: () => open(null),
  };
}
