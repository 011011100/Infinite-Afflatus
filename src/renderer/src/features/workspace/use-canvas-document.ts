import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasPatch } from '../../../../shared/canvas/model';
import {
  isTrimPatch,
  reversePatch,
} from '../../../../shared/canvas/operations';
import type { ProjectSnapshot } from '../../../../shared/models';
import { usePendingSave } from '../lifecycle/use-pending-save';

/** One short transaction at a time; failed writes restore the authoritative project. */
export function useCanvasDocument(
  initial: ProjectSnapshot,
  blocked: boolean,
  report: (reason: unknown) => void,
  prepareTransition: (patch: CanvasPatch) => (saved: boolean) => void,
) {
  const [snapshot, setSnapshot] = useState(initial);
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
  useEffect(() => {
    if (saving || writing.current) return;
    setSnapshot((current) =>
      initial.canvas.revision >= current.canvas.revision &&
      initial.assets.length >= current.assets.length
        ? initial
        : current,
    );
  }, [initial, saving]);

  const commit = useCallback(
    async (patch: CanvasPatch, action: 'edit' | 'undo' | 'redo' = 'edit') => {
      if (writing.current || blocked) return false;
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
        // An import/migration/external writer may have changed the project. Never overwrite it.
        try {
          setSnapshot(await window.desktop.openProject(initial.project.id));
        } catch (refreshError) {
          report(refreshError);
        }
        setHistory({ past: [], future: [] });
        return false;
      } finally {
        writing.current = false;
        setSaving(false);
        pending.current = null;
        resolveSave(successful);
      }
    },
    [initial.project.id, blocked, report, prepareTransition],
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
