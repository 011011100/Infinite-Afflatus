import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasPatch } from '../../../../shared/canvas/model';
import {
  isTrimPatch,
  reversePatch,
} from '../../../../shared/canvas/operations';
import type { ProjectSnapshot } from '../../../../shared/models';
import { usePendingSave } from '../lifecycle/use-pending-save';
import { useProjectRecoveryGuard } from '../projects/use-project-recovery-guard';
import { canResumeCanvas } from './canvas-recovery';

/** One short transaction at a time; failed writes restore the authoritative project. */
export function useCanvasDocument(
  initial: ProjectSnapshot,
  blocked: boolean,
  report: (reason: unknown) => void,
  prepareTransition: (patch: CanvasPatch) => (saved: boolean) => void,
) {
  const [snapshot, setSnapshot] = useState(initial);
  const confirmed = useRef(initial);
  const locked = useRef(blocked);
  locked.current = blocked;
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<{
    past: CanvasPatch[];
    future: CanvasPatch[];
  }>({ past: [], future: [] });
  const writing = useRef(false);
  const pending = useRef<Promise<boolean> | null>(null);
  usePendingSave(
    `主画布:${initial.project.id}`,
    () => pending.current ?? Promise.resolve(true),
  );
  useProjectRecoveryGuard(
    initial.project.id,
    async (remote, savedReferenceAssets) => {
      await pending.current;
      if (!canResumeCanvas(confirmed.current, remote, savedReferenceAssets))
        return '磁盘上的画布或素材记录与本页最后确认的版本不同。已保留当前页面和撤销记录，请先恢复原项目文件；未自动覆盖或合并。';
      return null;
    },
  );
  useEffect(() => {
    if (saving || writing.current) return;
    setSnapshot((current) => {
      const next =
        initial.canvas.revision >= current.canvas.revision &&
        initial.assets.length >= current.assets.length
          ? initial
          : current;
      confirmed.current = next;
      return next;
    });
  }, [initial, saving]);

  const commit = useCallback(
    async (patch: CanvasPatch, action: 'edit' | 'undo' | 'redo' = 'edit') => {
      if (writing.current || locked.current) return false;
      writing.current = true;
      let resolveSave!: (saved: boolean) => void;
      pending.current = new Promise<boolean>((resolve) => {
        resolveSave = resolve;
      });
      let successful = false;
      const finishTransition = prepareTransition(patch);
      setSaving(true);
      try {
        const saved = await window.desktop.patchCanvas(
          initial.project.id,
          patch,
        );
        confirmed.current = saved;
        setSnapshot(saved);
        finishTransition(true);
        setHistory((current) => {
          if (action === 'undo')
            return {
              past: current.past.slice(0, -1),
              future: [...current.future, reversePatch(patch)],
            };
          if (action === 'redo')
            return {
              past: [...current.past, patch],
              future: current.future.slice(0, -1),
            };
          return { past: [...current.past.slice(-49), patch], future: [] };
        });
        successful = true;
        return true;
      } catch (error) {
        finishTransition(false);
        report(error);
        // Recovery must compare against this confirmed baseline. A successful read
        // after a failed acknowledgement is not permission to adopt another version.
        return false;
      } finally {
        writing.current = false;
        setSaving(false);
        pending.current = null;
        resolveSave(successful);
      }
    },
    [initial.project.id, report, prepareTransition],
  );

  const undo = useCallback(() => {
    const patch = history.past.at(-1);
    if (patch) void commit(reversePatch(patch), 'undo');
  }, [history.past, commit]);
  const redo = useCallback(() => {
    const patch = history.future.at(-1);
    if (patch) void commit(patch, 'redo');
  }, [history.future, commit]);

  return {
    snapshot,
    saving,
    commit,
    undo,
    redo,
    undoCardId: history.past.at(-1)?.after[0]?.id,
    redoCardId: history.future.at(-1)?.before[0]?.id,
    canUndoTrim: isTrimPatch(history.past.at(-1)),
    canRedoTrim: isTrimPatch(history.future.at(-1)),
    canUndo: !!history.past.length,
    canRedo: !!history.future.length,
  };
}
