import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MainCanvasHistory,
  type MainCanvasHistoryDirection,
  type MainCanvasHistoryTicket,
} from '../../../../shared/canvas/main-history';
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
  applyShotListOperation,
  type ShotListOperation,
} from '../../../../shared/generation/shot-list-operations';
import {
  type GenerationWorkspace,
  newShot,
  type Point,
  type ShotWorkspace,
} from '../../../../shared/generation/workspace';
import type { Asset, ProjectSnapshot } from '../../../../shared/models';
import {
  sameWorkspace,
  type WorkspaceDraftRecord,
} from '../../../../shared/workspace-draft';
import { useWorkspaceDrafts } from '../drafts/use-workspace-drafts';
import { usePendingSave } from '../lifecycle/use-pending-save';
import { useProjectRecoveryGuard } from '../projects/use-project-recovery-guard';
import {
  type ArkAdoptionBaseline,
  type ArkAdoptionCanvasLease,
  arkAdoptionDidNotCommit,
  requestArkAdoption,
} from './ark-adoption';
import { message } from './errors';
import type { ReferenceImportTarget } from './reference-import-target';
import { saveWorkspaceSubmission } from './workspace-save-submission';

type WorkspaceSubmission = { submitted: GenerationWorkspace; version: number };

/** One project-scoped save stream, including edits made while an earlier write is pending. */
export function useShotWorkspace(
  projectId: string,
  blocked: boolean,
  report?: (reason: unknown) => void,
  sharedHistory?: MainCanvasHistory,
) {
  const [localHistory] = useState(() => new MainCanvasHistory());
  const mainHistory = sharedHistory ?? localHistory;
  const [workspace, setWorkspace] = useState<GenerationWorkspace | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedEdit, setSavedEdit] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const adoptingRef = useRef(false);
  const adoptionLocked = useRef(false);
  const adoption = useRef<Promise<void> | null>(null);
  const adoptionJob = useRef<string | null>(null);
  const adoptionAttempt = useRef<{
    baseline: ArkAdoptionBaseline;
    version: number;
    lease: ArkAdoptionCanvasLease;
    notify?: (snapshot: ProjectSnapshot) => Promise<void>;
  } | null>(null);
  const isAdopting = useCallback(() => adoptingRef.current, []);
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
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const locked = useRef(blocked);
  const history = useRef(new ShotHistory());
  const imports = useRef(new Set<symbol>());
  // Keep a staged copy's identity across save failures. Retrying opens that copy,
  // even when the ordinary save timer has since persisted it successfully.
  const copyCandidates = useRef(new Map<string, string>());
  const copying = useRef<Promise<ShotWorkspace | null> | null>(null);
  const listing = useRef<Promise<boolean> | null>(null);
  const listSubmission = useRef<{
    version: number;
    ticket: MainCanvasHistoryTicket;
    inverse: ShotListOperation;
  } | null>(null);
  const unconfirmed = useRef<WorkspaceSubmission | null>(null);
  locked.current = blocked || recoveringRef.current || adoptionLocked.current;
  const confirmSubmission = useCallback(
    async (result: GenerationWorkspace, attempt: WorkspaceSubmission) => {
      if (unconfirmed.current !== attempt) return;
      if (
        !sameWorkspace(result, {
          ...attempt.submitted,
          revision: attempt.submitted.revision + 1,
        })
      )
        throw new Error('镜头保存回执与提交内容不一致，已保留输入与撤销记录。');
      confirmed.current = result;
      if (current.current)
        current.current = { ...current.current, revision: result.revision };
      unconfirmed.current = null;
      saved.current = attempt.version;
      setSavedEdit(attempt.version);
      const list = listSubmission.current;
      if (list && attempt.version >= list.version) {
        listSubmission.current = null;
        list.ticket.commit({ kind: 'shot', operation: list.inverse });
      }
      const settled = draftQueue.confirm(result, current.current ?? result);
      await draftQueue.flush();
      if (saved.current === edit.current) await draftQueue.acknowledge(settled);
    },
    [draftQueue],
  );
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
          const previous = unconfirmed.current;
          if (previous) {
            const remote =
              await window.desktop.getGenerationWorkspace(projectId);
            if (unconfirmed.current !== previous) continue;
            if (
              sameWorkspace(remote, {
                ...previous.submitted,
                revision: previous.submitted.revision + 1,
              })
            ) {
              await confirmSubmission(remote, previous);
              continue;
            }
            if (!confirmed.current || !sameWorkspace(remote, confirmed.current))
              throw new Error(
                '磁盘上的镜头草稿与本次提交不一致，已保留输入与撤销记录；未覆盖其他版本。',
              );
            unconfirmed.current = null;
          }
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
          const submission = { submitted: structuredClone(submitted), version };
          unconfirmed.current = submission;
          const result = await saveWorkspaceSubmission(
            window.desktop,
            projectId,
            submitted,
          );
          await confirmSubmission(result, submission);
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
  }, [projectId, draftQueue, confirmSubmission]);
  usePendingSave(
    `镜头草稿:${projectId}`,
    () =>
      adoption.current?.then(
        () => true,
        () => false,
      ) ??
      (adoptionAttempt.current ? Promise.resolve(false) : null) ??
      listing.current ??
      copying.current?.then(Boolean) ??
      flush(),
    0,
    () =>
      adoption.current?.then(
        () => true,
        () => false,
      ) ??
      (adoptionAttempt.current ? Promise.resolve(false) : null) ??
      listing.current ??
      copying.current?.then(Boolean) ??
      pending.current,
  );
  useProjectRecoveryGuard(projectId, async () => {
    await adoption.current?.catch(() => undefined);
    if (adoptionAttempt.current)
      return '生成结果采用尚未确认，请先重试核对同一候选结果；当前内容和撤销记录仍保留。';
    await pending.current;
    const remote = await window.desktop.getGenerationWorkspace(projectId);
    const previous = unconfirmed.current;
    if (
      previous &&
      sameWorkspace(remote, {
        ...previous.submitted,
        revision: previous.submitted.revision + 1,
      })
    ) {
      // This only acknowledges our proven write. Other project guards may still
      // refuse to resume; the outer edit lock remains authoritative.
      await confirmSubmission(remote, previous);
      setError(null);
    }
    if (confirmed.current && !sameWorkspace(remote, confirmed.current))
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
      if (!current.current || locked.current || adoptingRef.current) return;
      commit(update(current.current));
    },
    [commit],
  );
  const stageListOperation = (
    operation: ShotListOperation,
    direction: MainCanvasHistoryDirection = 'edit',
    prepared?: MainCanvasHistoryTicket,
  ) => {
    const doc = current.current;
    if (!doc || locked.current || adoptingRef.current || listSubmission.current)
      return false;
    const changed = applyShotListOperation(doc.shots, operation);
    if (!changed) return false;
    const ticket =
      prepared ?? mainHistory.begin({ kind: 'shot', operation }, direction);
    if (!ticket) return false;
    listSubmission.current = {
      ticket,
      inverse: changed.inverse,
      version: edit.current + 1,
    };
    commit({ ...doc, shots: changed.shots });
    return true;
  };
  const beginReferenceImport = (
    shotId: string,
  ): ReferenceImportTarget | null => {
    if (
      locked.current ||
      adoptingRef.current ||
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
          adoptingRef.current ||
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
      adoptingRef.current ||
      edit.current !== saved.current ||
      pending.current ||
      copying.current ||
      mainHistory.getSnapshot().busy
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
        unconfirmed.current = null;
        history.current = new ShotHistory();
        mainHistory.discardKind('shot');
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
      adoptingRef.current ||
      listing.current ||
      (id && !current.current?.shots.some((shot) => shot.id === id))
    )
      return;
    if (activeId) history.current.breakMerge(activeId);
    if (id) history.current.breakMerge(id);
    setActiveId(id);
  };
  const create = (position: Point, asset?: Asset) => {
    if (
      !current.current ||
      locked.current ||
      adoptingRef.current ||
      mainHistory.getSnapshot().busy
    )
      return;
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
    const shot = newShot(
      id,
      asset?.name.slice(0, 100) ??
        `镜头 ${String(current.current.shots.length + 1).padStart(2, '0')}`,
      position,
      asset?.id,
    );
    if (asset) change((doc) => ({ ...doc, shots: [...doc.shots, shot] }));
    else if (
      !stageListOperation({
        type: 'insert',
        shot,
        index: current.current.shots.length,
      })
    )
      return;
    open(id);
  };
  const duplicate = (sourceId: string, position: Point) => {
    if (copying.current) return copying.current;
    copying.current = (async () => {
      if (locked.current || adoptingRef.current || !current.current)
        return null;
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
        if (
          !stageListOperation({
            type: 'insert',
            shot: copy,
            index: doc.shots.length,
          })
        )
          return null;
        copyCandidates.current.set(sourceId, copy.id);
        history.current.breakMerge(sourceId);
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
  const applyListOperation = (
    operation: ShotListOperation,
    direction: MainCanvasHistoryDirection = 'edit',
  ) => {
    if (
      locked.current ||
      adoptingRef.current ||
      listing.current ||
      copying.current ||
      imports.current.size ||
      mainHistory.getSnapshot().busy ||
      activeId
    )
      return Promise.resolve(false);
    const ticket = mainHistory.begin({ kind: 'shot', operation }, direction);
    if (!ticket) return Promise.resolve(false);
    listing.current = (async () => {
      try {
        if (!(await flush()) || locked.current || imports.current.size)
          return false;
        const target =
          operation.type === 'insert'
            ? operation.shot
            : current.current?.shots.find((shot) => shot.id === operation.id);
        if (target?.sourceAssetId)
          throw new Error(
            '视频关联镜头由原视频保留，不能作为独立镜头移除或移动。',
          );
        if (!stageListOperation(operation, direction, ticket)) return false;
        return await flush();
      } catch (reason) {
        setError(message(reason));
        return false;
      } finally {
        if (listSubmission.current?.ticket !== ticket) ticket.abort();
        listing.current = null;
      }
    })();
    return listing.current;
  };
  const adoptGeneration = (
    jobId: string,
    reserveCanvas?: () => ArkAdoptionCanvasLease | null,
    notify?: (snapshot: ProjectSnapshot) => Promise<void>,
  ): Promise<void> => {
    if (adoption.current) {
      if (adoptionJob.current !== jobId)
        return Promise.reject(new Error('请先完成当前候选结果的采用。'));
      return adoption.current;
    }
    const previous = adoptionAttempt.current;
    if (previous && previous.baseline.jobId !== jobId)
      return Promise.reject(
        new Error('请先重试确认原候选结果，不能同时采用其他结果。'),
      );
    if (
      !previous &&
      (locked.current ||
        adoptingRef.current ||
        !current.current ||
        copying.current ||
        listing.current ||
        imports.current.size ||
        mainHistory.getSnapshot().busy)
    )
      return Promise.reject(
        new Error('请先完成当前编辑、素材导入或保存，再采用生成结果。'),
      );
    // Reserve before publishing the adoption lock; React may render it while
    // the ordinary workspace save below is still draining.
    const reserved = previous ? null : reserveCanvas?.();
    if (!previous && !reserved)
      return Promise.reject(
        new Error('主画布尚有未完成的修改，请保存后再采用结果。'),
      );
    adoptionJob.current = jobId;
    adoptingRef.current = true;
    setAdopting(true);
    // Yield once so every leave guard sees the complete operation before IPC begins.
    const operation = Promise.resolve().then(async () => {
      let attempt = previous;
      try {
        if (!attempt) {
          if (
            !(await flush()) ||
            locked.current ||
            !current.current ||
            imports.current.size ||
            copying.current ||
            listing.current ||
            mainHistory.getSnapshot().busy
          )
            throw new Error('当前镜头尚未保存完成，请检查保存提示后重试采用。');
          const lease = reserved;
          if (!lease)
            throw new Error('主画布尚有未完成的修改，请保存后再采用结果。');
          attempt = {
            baseline: {
              jobId,
              project: structuredClone(lease.snapshot),
              workspace: structuredClone(current.current),
            },
            version: edit.current,
            lease,
            ...(notify ? { notify } : {}),
          };
          adoptionAttempt.current = attempt;
          adoptionLocked.current = true;
          locked.current = true;
        } else attempt.lease.resume();
        const result = await requestArkAdoption(
          window.desktop,
          attempt.baseline,
        );
        if (
          adoptionAttempt.current !== attempt ||
          edit.current !== attempt.version ||
          saved.current !== attempt.version ||
          !current.current ||
          !sameWorkspace(current.current, attempt.baseline.workspace)
        )
          throw new Error(
            '采用期间镜头输入发生变化，当前内容仍保留，未应用旧回执。',
          );
        // The canvas reservation validates before either editor installs this receipt.
        attempt.lease.accept(result);
        if (result.kind === 'image') {
          const before = attempt.baseline.workspace.shots.find(
            (shot) => shot.id === result.sourceShotId,
          );
          const after = result.workspace.shots.find(
            (shot) => shot.id === result.shotId,
          );
          if (before && after) history.current.record(before, after);
        }
        confirmed.current = result.workspace;
        current.current = result.workspace;
        unconfirmed.current = null;
        setWorkspace(result.workspace);
        setError(null);
        // Advance the independent recovery watermark before releasing the edit lock.
        // Older protect/acknowledge messages cannot resurrect the pre-adoption draft.
        const settled = draftQueue.confirm(result.workspace, result.workspace);
        if (await draftQueue.flush()) await draftQueue.acknowledge(settled);
        adoptionAttempt.current = null;
        attempt.lease.finish(true);
        adoptionLocked.current = false;
        try {
          await attempt.notify?.(result.snapshot);
        } catch (reason) {
          // The exact commit is already installed. A library refresh failure is not
          // permission to submit another adoption or roll back either editor.
          setError(`生成结果已采用，项目状态刷新失败：${message(reason)}`);
        }
      } catch (reason) {
        if (!attempt) reserved?.finish(false);
        if (attempt && adoptionAttempt.current === attempt) {
          if (await arkAdoptionDidNotCommit(window.desktop, attempt.baseline)) {
            adoptionAttempt.current = null;
            adoptionLocked.current = false;
            attempt.lease.finish(false);
          } else attempt.lease.pause();
        }
        setError(message(reason));
        throw reason;
      } finally {
        adoption.current = null;
        adoptionJob.current = adoptionAttempt.current?.baseline.jobId ?? null;
        locked.current =
          blockedRef.current || recoveringRef.current || adoptionLocked.current;
        adoptingRef.current = adoptionAttempt.current !== null;
        setAdopting(adoptingRef.current);
      }
    });
    adoption.current = operation;
    return operation;
  };

  return {
    shots: workspace?.shots ?? [],
    recovery,
    recoverDraft,
    recovering,
    isRecovering,
    adopting,
    pendingAdoptionJobId: adoptionJob.current,
    isAdopting,
    adoptGeneration,
    baseline: confirmed.current,
    dirty: edit.current !== saved.current,
    loaded: !!workspace,
    saving: saving || adopting || savedEdit !== edit.current,
    error,
    setError,
    activeShot: workspace?.shots.find((shot) => shot.id === activeId),
    activeId,
    open,
    create,
    duplicate,
    duplicatePending: !!activeId && copyCandidates.current.has(activeId),
    applyListOperation,
    updateShot,
    beginReferenceImport,
    historyFor: (id: string): ShotHistoryActions => ({
      ...history.current.state(id),
      undo: () => restore(id, 'undo'),
      redo: () => restore(id, 'redo'),
      breakMerge: () => history.current.breakMerge(id),
    }),
    flush: () =>
      adoption.current?.then(
        () => true,
        () => false,
      ) ?? (adoptionAttempt.current ? Promise.resolve(false) : flush()),
    retry: async () => {
      if (adoptionAttempt.current) {
        try {
          await adoptGeneration(adoptionAttempt.current.baseline.jobId);
          return true;
        } catch {
          return false;
        }
      }
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
