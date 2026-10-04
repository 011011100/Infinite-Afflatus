const listeners = new Map<string, Set<() => void>>();

/** Invalidate lists only. Importing a recovery copy never saves or replaces live edits. */
export function notifyDraftLists(projectId: string) {
  for (const refresh of listeners.get(projectId) ?? []) refresh();
}

export function subscribeDraftLists(projectId: string, refresh: () => void) {
  const project = listeners.get(projectId) ?? new Set<() => void>();
  project.add(refresh);
  listeners.set(projectId, project);
  return () => {
    project.delete(refresh);
    if (!project.size) listeners.delete(projectId);
  };
}
