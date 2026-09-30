import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type GenerationWorkspace,
  newShot,
  type Point,
  type ShotWorkspace,
} from '../../../../shared/generation/workspace';
import type { Asset } from '../../../../shared/models';
import { message } from './errors';

/** One project-scoped save stream, including edits made while an earlier write is pending. */
export function useShotWorkspace(projectId: string, blocked: boolean) {
  const [workspace, setWorkspace] = useState<GenerationWorkspace | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedEdit, setSavedEdit] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<GenerationWorkspace | null>(null);
  const edit = useRef(0);
  const saved = useRef(0);
  const pending = useRef<Promise<boolean> | null>(null);
  const locked = useRef(blocked);
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
          current.current = { ...current.current, revision: result.revision };
          saved.current = version;
          setSavedEdit(version);
        }
        setError(null);
        return true;
      } catch (reason) {
        setError(message(reason));
        return false;
      } finally {
        pending.current = null;
        setSaving(false);
      }
    })();
    return pending.current;
  }, [projectId]);
  useEffect(() => {
    let active = true;
    void window.desktop
      .getGenerationWorkspace(projectId)
      .then((value) => {
        if (active) {
          current.current = value;
          setWorkspace(value);
        }
      })
      .catch((reason) => active && setError(message(reason)));
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
    (id: string, update: (shot: ShotWorkspace) => ShotWorkspace) => {
      change((doc) => ({
        ...doc,
        shots: doc.shots.map((shot) => (shot.id === id ? update(shot) : shot)),
      }));
    },
    [change],
  );
  const create = (position: Point, asset?: Asset) => {
    if (!current.current || blocked) return;
    const existing =
      asset &&
      current.current.shots.find((shot) => shot.sourceAssetId === asset.id);
    if (existing) {
      setActiveId(existing.id);
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
    setActiveId(id);
  };
  return {
    shots: workspace?.shots ?? [],
    loaded: !!workspace,
    saving: saving || savedEdit !== edit.current,
    error,
    setError,
    activeShot: workspace?.shots.find((shot) => shot.id === activeId),
    activeId,
    open: setActiveId,
    create,
    updateShot,
    flush,
    retry: async () => {
      if (current.current) return flush();
      try {
        const loaded = await window.desktop.getGenerationWorkspace(projectId);
        current.current = loaded;
        setWorkspace(loaded);
        setError(null);
        return true;
      } catch (reason) {
        setError(message(reason));
        return false;
      }
    },
    close: async () => {
      if (await flush()) setActiveId(null);
    },
  };
}
