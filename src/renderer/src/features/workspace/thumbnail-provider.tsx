import { createContext, type ReactNode, use, useEffect, useState } from 'react';
import type { Asset } from '../../../../shared/models';
import { decodeThumbnail, type ThumbnailFrame } from './decode-thumbnail';
import { mediaUrl } from './media';
import { ThumbnailCache } from './thumbnail-cache';
import { useMediaRevision } from './use-media-revision';

export const ThumbnailContext =
  createContext<ThumbnailCache<ThumbnailFrame> | null>(null);

export function ThumbnailProvider({ children }: { children: ReactNode }) {
  const [cache] = useState(() => new ThumbnailCache<ThumbnailFrame>());
  useEffect(() => () => cache.clear(), [cache]);
  return <ThumbnailContext value={cache}>{children}</ThumbnailContext>;
}

export function useThumbnail(projectId: string, asset: Asset) {
  const cache = use(ThumbnailContext);
  if (!cache) throw new Error('ThumbnailProvider is missing');
  const revision = useMediaRevision(projectId, asset.id);
  const key = `${projectId}/${asset.id}/${asset.sha256}/${revision}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    frame: ThumbnailFrame | undefined;
    failed: boolean;
  }>(() => ({ key, frame: cache.get(key), failed: false }));
  useEffect(() => {
    let active = true;
    void cache
      .load(key, (signal) =>
        decodeThumbnail(mediaUrl(projectId, asset.id, revision), signal),
      )
      .then(
        (frame) => active && setLoaded({ key, frame, failed: false }),
        () => active && setLoaded({ key, frame: undefined, failed: true }),
      );
    return () => {
      active = false;
    };
  }, [cache, key, projectId, asset.id, revision]);
  return loaded.key === key
    ? loaded
    : { key, frame: cache.get(key), failed: false };
}
