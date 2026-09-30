import { useCallback, useEffect, useRef, useState } from 'react';
import type { GenerationDraft } from '../../../../shared/generation/draft';

export function useGenerationDraft(projectId: string, blocked: boolean) {
  const [draft, setDraft] = useState<GenerationDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const current = useRef<GenerationDraft | null>(null);
  const edit = useRef(0);
  const saved = useRef(0);
  const pending = useRef<Promise<boolean> | null>(null);
  const [savedEdit, setSavedEdit] = useState(0);

  useEffect(() => {
    let active = true;
    void window.desktop
      .getGenerationDraft(projectId)
      .then((value) => {
        if (!active) return;
        current.current = value;
        setDraft(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(message(reason));
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const change = useCallback(
    (update: (value: GenerationDraft) => GenerationDraft) => {
      if (!current.current) return;
      current.current = update(current.current);
      edit.current += 1;
      setDraft(current.current);
    },
    [],
  );

  const flush = useCallback((): Promise<boolean> => {
    if (pending.current) return pending.current;
    if (!current.current || saved.current === edit.current)
      return Promise.resolve(true);
    if (blocked) return Promise.resolve(false);
    setSaving(true);
    pending.current = (async () => {
      try {
        // Serialize acknowledgements; a slow save cannot overwrite subsequent typing.
        while (current.current && saved.current !== edit.current) {
          const version = edit.current;
          const result = await window.desktop.saveGenerationDraft(
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
  }, [projectId, blocked]);

  useEffect(() => {
    if (!draft || blocked || saved.current === edit.current) return;
    const timer = window.setTimeout(() => {
      void flush();
    }, 500);
    return () => window.clearTimeout(timer);
  }, [draft, blocked, flush]);

  return {
    draft,
    change,
    flush,
    saving,
    dirty: savedEdit !== edit.current,
    error,
    setError,
  };
}

export function message(reason: unknown): string {
  return (reason instanceof Error ? reason.message : String(reason)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );
}
