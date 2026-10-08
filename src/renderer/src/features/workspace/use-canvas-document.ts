import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { MainCanvasHistory } from '../../../../shared/canvas/main-history';
import { type CanvasPatch, sameCard } from '../../../../shared/canvas/model';
import {
  isTrimPatch,
  reversePatch,
} from '../../../../shared/canvas/operations';
import type { ArkAdoptionResult } from '../../../../shared/generation/ark-types';
import type { ProjectSnapshot } from '../../../../shared/models';
import type { ProjectEditDraftRecord } from '../../../../shared/project-edit-draft';
import {
  type ProjectEditRecoveryAttempt,
  projectEditRecoveryGuards,
} from '../drafts/project-edit-recovery-guards';
import { validateArkProjectAdoption } from '../generation/ark-adoption';
import { usePendingSave } from '../lifecycle/use-pending-save';
import { useProjectRecoveryGuard } from '../projects/use-project-recovery-guard';
import { canResumeCanvas } from './canvas-recovery';
import {
  type CanvasAction,
  type PendingTrimSubmission,
  TrimDraftController,
  type TrimSubmission,
} from './editor/trim-draft-controller';

/** One short transaction at a time; failed writes restore the authoritative project. */
export function useCanvasDocument(
  initial: ProjectSnapshot,
  blocked: boolean,
  report: (reason: unknown) => void,
  prepareTransition: (patch: CanvasPatch) => (saved: boolean) => void,
  sharedHistory?: MainCanvasHistory,
) {
  const [snapshot, setSnapshot] = useState(initial);
  const confirmed = useRef(initial);
  const locked = useRef(blocked);
  locked.current = blocked;
  const [saving, setSaving] = useState(false);
  const [trimRecovery] = useState(
    () => new TrimDraftController(initial.project.id, window.desktop),
  );
  const trimState = useSyncExternalStore(
    trimRecovery.subscribe,
    trimRecovery.getSnapshot,
  );
  const approvedRecovery = useRef<{
    snapshot: ProjectSnapshot;
    ticket: PendingTrimSubmission;
  } | null>(null);
  const acceptedInitial = useRef(initial);
  const adoptedAssets = useRef(new Map<string, string>());
  const [localHistory] = useState(() => new MainCanvasHistory());
  const mainHistory = sharedHistory ?? localHistory;
  const history = useSyncExternalStore(
    mainHistory.subscribe,
    mainHistory.getSnapshot,
  );
  const writing = useRef(false);
  const pending = useRef<Promise<boolean> | null>(null);
  const settleHistory = useCallback(
    (patch: CanvasPatch, action: CanvasAction) => {
      const ticket = mainHistory.begin({ kind: 'video', patch }, action);
      return ticket?.commit({ kind: 'video', patch: reversePatch(patch) });
    },
    [mainHistory],
  );
  usePendingSave(
    `主画布:${initial.project.id}`,
    () =>
      pending.current ??
      Promise.resolve(!writing.current && !trimRecovery.hasPendingEdits()),
  );
  useProjectRecoveryGuard(
    initial.project.id,
    async (remote, savedReferenceAssets) => {
      await pending.current;
      if (!canResumeCanvas(confirmed.current, remote, savedReferenceAssets)) {
        const ticket = trimRecovery.recoveryCandidate(
          remote,
          savedReferenceAssets,
        );
        if (ticket) {
          // Eligibility only: another editor may still reject this same snapshot.
          approvedRecovery.current = { snapshot: remote, ticket };
          return null;
        }
        return '磁盘上的画布或素材记录与本页最后确认的版本不同。已保留当前页面和撤销记录，请先恢复原项目文件；未自动覆盖或合并。';
      }
      return null;
    },
  );
  useLayoutEffect(() => {
    if (saving || writing.current || blocked) return;
    // Changing saving/blocked alone does not make the old prop a fresh verified read.
    if (acceptedInitial.current === initial) return;
    acceptedInitial.current = initial;
    const approved = approvedRecovery.current;
    const candidate = trimRecovery.recoveryCandidate(initial);
    const ticket =
      approved?.snapshot === initial
        ? approved.ticket
        : candidate?.source === 'edit'
          ? candidate
          : null;
    // Explicit recovery may lose both the returned snapshot and its old draft.
    // Only a snapshot accepted by every live recovery guard can settle it.
    if (candidate?.source === 'recovery' && !ticket) return;
    const current = confirmed.current;
    if (
      initial.canvas.revision < current.canvas.revision ||
      initial.assets.length < current.assets.length ||
      [...adoptedAssets.current].some(
        ([id, value]) =>
          JSON.stringify(initial.assets.find((asset) => asset.id === id)) !==
          value,
      )
    )
      return;
    // Update the ref synchronously before child passive effects retry their queue.
    confirmed.current = initial;
    setSnapshot(initial);
    if (ticket && trimRecovery.adoptRecovered(ticket)) {
      settleHistory(ticket.patch, ticket.action);
      approvedRecovery.current = null;
    } else trimRecovery.acceptUnchanged(initial);
  }, [initial, saving, blocked, trimRecovery, settleHistory]);

  const commit = useCallback(
    async (patch: CanvasPatch, action: 'edit' | 'undo' | 'redo' = 'edit') => {
      if (
        writing.current ||
        locked.current ||
        trimRecovery.hasUnconfirmedSubmission() ||
        projectEditRecoveryGuards.isRecovering(initial.project.id)
      )
        return false;
      if (trimRecovery.hasPendingEdits() && !isTrimPatch(patch)) return false;
      const historyTicket = mainHistory.begin({ kind: 'video', patch }, action);
      if (!historyTicket) return false;
      writing.current = true;
      let resolveSave!: (saved: boolean) => void;
      pending.current = new Promise<boolean>((resolve) => {
        resolveSave = resolve;
      });
      let successful = false;
      let trim: TrimSubmission | null = null;
      let sent = false;
      const finishTransition = prepareTransition(patch);
      setSaving(true);
      try {
        if (isTrimPatch(patch)) {
          trim = await trimRecovery.prepare(confirmed.current, patch, action);
          if (
            locked.current ||
            projectEditRecoveryGuards.isRecovering(initial.project.id)
          ) {
            finishTransition(false);
            return false;
          }
        }
        sent = true;
        const saved = await window.desktop.patchCanvas(
          initial.project.id,
          patch,
        );
        confirmed.current = saved;
        setSnapshot(saved);
        finishTransition(true);
        historyTicket.commit({ kind: 'video', patch: reversePatch(patch) });
        if (trim) await trimRecovery.committed(trim);
        successful = true;
        return true;
      } catch (error) {
        finishTransition(false);
        if (trim && sent) trimRecovery.failed(trim);
        // A failed independent checkpoint does not mean the project volume is unavailable.
        if (sent) report(error);
        // Recovery must compare against this confirmed baseline. A successful read
        // after a failed acknowledgement is not permission to adopt another version.
        return false;
      } finally {
        historyTicket.abort();
        writing.current = false;
        setSaving(false);
        pending.current = null;
        resolveSave(successful);
      }
    },
    [initial.project.id, report, prepareTransition, mainHistory, trimRecovery],
  );

  // Reserve the existing canvas write lane before backend adoption. This also
  // keeps parent refreshes and native close from racing its authoritative reply.
  const beginGenerationAdoption = () => {
    if (
      writing.current ||
      locked.current ||
      mainHistory.getSnapshot().busy ||
      trimRecovery.hasPendingEdits() ||
      projectEditRecoveryGuards.isRecovering(initial.project.id)
    )
      return null;
    const baseline = confirmed.current;
    writing.current = true;
    setSaving(true);
    let settle!: (saved: boolean) => void;
    const resume = () => {
      if (pending.current) return;
      pending.current = new Promise<boolean>((resolve) => {
        settle = resolve;
      });
    };
    resume();
    let active = true;
    return {
      snapshot: baseline,
      resume,
      pause: () => {
        pending.current = null;
        settle(false);
      },
      accept: (result: ArkAdoptionResult) => {
        if (!active || confirmed.current !== baseline)
          throw new Error('采用期间主画布版本发生变化，未替换当前画布。');
        validateArkProjectAdoption(baseline, result);
        const saved = { ...result.snapshot, viewport: baseline.viewport };
        confirmed.current = saved;
        adoptedAssets.current.set(
          result.assetId,
          JSON.stringify(
            saved.assets.find((asset) => asset.id === result.assetId),
          ),
        );
        setSnapshot(saved);
        trimRecovery.acceptUnchanged(saved);
      },
      finish: (saved: boolean) => {
        if (!active) return;
        active = false;
        writing.current = false;
        pending.current = null;
        setSaving(false);
        settle(saved);
      },
    };
  };

  const undo = useCallback(() => {
    const operation = mainHistory.getSnapshot().undo;
    if (operation?.kind === 'video') void commit(operation.patch, 'undo');
  }, [mainHistory, commit]);
  const redo = useCallback(() => {
    const operation = mainHistory.getSnapshot().redo;
    if (operation?.kind === 'video') void commit(operation.patch, 'redo');
  }, [mainHistory, commit]);

  const acceptRecoveredEdit = useCallback(
    (record: ProjectEditDraftRecord, saved: ProjectSnapshot) => {
      if (record.kind !== 'trim') return;
      if (writing.current || trimRecovery.hasPendingEdits())
        throw new Error('请先处理当前裁剪，再恢复旧草稿');
      const before = confirmed.current.canvas.cards.find(
        (card) => card.id === record.baseline.id,
      );
      const after = saved.canvas.cards.find(
        (card) => card.id === record.baseline.id,
      );
      if (saved.project.id !== initial.project.id || !before || !after)
        throw new Error('恢复的裁剪卡片与当前项目不匹配');
      const patch = { before: [before], after: [after] };
      if (!isTrimPatch(patch))
        throw new Error('恢复期间卡片结构发生变化，原撤销记录已保留');
      if (!sameCard(before, after)) settleHistory(patch, 'edit');
      confirmed.current = saved;
      setSnapshot(saved);
    },
    [initial.project.id, settleHistory, trimRecovery],
  );

  const prepareRecoveredEdit = useCallback(
    (
      record: ProjectEditDraftRecord,
    ): ProjectEditRecoveryAttempt | undefined => {
      if (record.kind !== 'trim') return;
      if (writing.current || trimRecovery.hasPendingEdits())
        throw new Error('请先处理当前裁剪，再恢复旧草稿');
      const ticket = trimRecovery.prepareRecovery(confirmed.current, record);
      let active = true;
      return {
        failed: (reason) => {
          if (!active) return;
          active = false;
          trimRecovery.failedRecovery(ticket);
          report(reason);
        },
        complete: () => {
          active = false;
        },
      };
    },
    [trimRecovery, report],
  );

  return {
    snapshot,
    saving,
    beginGenerationAdoption,
    commit,
    undo,
    redo,
    trimRecovery,
    trimRecoveryError: trimState.error,
    canRecoverProjectEdits: () =>
      !writing.current && !trimRecovery.hasPendingEdits(),
    acceptRecoveredEdit,
    prepareRecoveredEdit,
    undoCardId:
      history.undo?.kind === 'video'
        ? history.undo.patch.before[0]?.id
        : undefined,
    redoCardId:
      history.redo?.kind === 'video'
        ? history.redo.patch.before[0]?.id
        : undefined,
    canUndoTrim:
      !history.busy &&
      history.undo?.kind === 'video' &&
      isTrimPatch(history.undo.patch),
    canRedoTrim:
      !history.busy &&
      history.redo?.kind === 'video' &&
      isTrimPatch(history.redo.patch),
    canUndo: !history.busy && history.undo?.kind === 'video',
    canRedo: !history.busy && history.redo?.kind === 'video',
  };
}
