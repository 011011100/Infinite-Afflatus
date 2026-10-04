import { useCallback, useEffect, useRef, useState } from 'react';
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
import { usePendingSave } from '../lifecycle/use-pending-save';
import { useProjectRecoveryGuard } from '../projects/use-project-recovery-guard';
import { message } from './errors';

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
  const current = useRef<GenerationWorkspace | null>(null);
  const confirmed = useRef<GenerationWorkspace | null>(null);
  const reportError = useRef(report);
  reportError.current = report;
  const edit = useRef(0);
  const saved = useRef(0);
  const pending = useRef<Promise<boolean> | null>(null);
  const locked = useRef(blocked);
  const history = useRef(new ShotHistory());
  locked.current = blocked;
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
          const result = await window.desktop.saveGenerationWorkspace(
            projectId,
            current.current,
          );
          confirmed.current = result;
          current.current = { ...current.current, revision: result.revision };
          saved.current = version;
          setSavedEdit(version);
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
  }, [projectId]);
  usePendingSave(`镜头草稿:${projectId}`, flush);
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
  const change = useCallback(
    (update: (value: GenerationWorkspace) => GenerationWorkspace) => {
      if (!current.current || locked.current) return;
      const next = update(current.current);
      if (next === current.current) return;
      current.current = next;
      edit.current += 1;
      setWorkspace(next);
    },
    [],
  );
  useEffect(() => {
    if (!workspace || blocked || saved.current === edit.current) return;
    const timer = setTimeout(() => {
      void flush();
    }, 350);
    return () => clearTimeout(timer);
  }, [workspace, blocked, flush]);
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
    if (activeId) history.current.breakMerge(activeId);
    if (id) history.current.breakMerge(id);
    setActiveId(id);
  };
  const create = (position: Point, asset?: Asset) => {
    if (!current.current || blocked) return;
    const existing =
      asset &&
      current.current.shots.find((shot) => shot.sourceAssetId === asset.id);
    if (existing) {
      open(existing.id);
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
  return {
    shots: workspace?.shots ?? [],
    loaded: !!workspace,
    saving: saving || savedEdit !== edit.current,
    error,
    setError,
    activeShot: workspace?.shots.find((shot) => shot.id === activeId),
    activeId,
    open,
    create,
    updateShot,
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
