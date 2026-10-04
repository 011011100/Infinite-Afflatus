import { useSyncExternalStore } from 'react';

const versions = new Map<string, number>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const mediaRevision = (projectId: string, assetId?: string) =>
  versions.get(assetId ? `${projectId}/${assetId}` : projectId) ?? 0;

/** A repaired file has the same ID and hash; media elements still need a fresh URL and decode attempt. */
export function refreshRestoredMedia(projectId: string, assetId: string) {
  versions.set(projectId, mediaRevision(projectId) + 1);
  versions.set(
    `${projectId}/${assetId}`,
    mediaRevision(projectId, assetId) + 1,
  );
  for (const listener of listeners) listener();
}

export function useMediaRevision(projectId: string, assetId?: string) {
  return useSyncExternalStore(subscribe, () =>
    mediaRevision(projectId, assetId),
  );
}
