import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { Asset } from '../../../../shared/models';
import type { ThumbnailFrame } from './decode-thumbnail';
import { mediaUrl } from './media';
import { frameMetadata, ThumbnailResources } from './thumbnail-resources';
import { useMediaRevision } from './use-media-revision';
import type { VideoMetadata } from './video-metadata';

export const ThumbnailActivityContext = createContext(true);

export const ThumbnailContext = createContext<ThumbnailResources | null>(null);

export function ThumbnailProvider({ children }: { children: ReactNode }) {
  const [resources] = useState(() => new ThumbnailResources());
  useEffect(() => () => resources.clear(), [resources]);
  return <ThumbnailContext value={resources}>{children}</ThumbnailContext>;
}

export function useThumbnail(
  projectId: string,
  asset: Asset,
  requested: boolean,
  retained: boolean,
  priority: number,
) {
  const resources = use(ThumbnailContext);
  if (!resources) throw new Error('ThumbnailProvider is missing');
  const revision = useMediaRevision(projectId, asset.id);
  const priorityRef = useRef(priority);
  priorityRef.current = priority;
  const key = `${projectId}/${asset.id}/${asset.sha256}/${revision}`;
  const [loaded, setLoaded] = useState<{
    key: string;
    frame: ThumbnailFrame | undefined;
    failed: boolean;
    metadata?: VideoMetadata | undefined;
  }>(() => {
    const frame = retained ? resources.cache.get(key) : undefined;
    return {
      key,
      frame,
      failed: false,
      metadata: frame ? frameMetadata(frame) : resources.metadata.get(key),
    };
  });
  useEffect(() => {
    if (!requested) return;
    let active = true;
    const controller = new AbortController();
    void resources
      .load(
        key,
        mediaUrl(projectId, asset.id, revision),
        controller.signal,
        priorityRef.current,
      )
      .then(
        (frame) =>
          active &&
          setLoaded({
            key,
            frame,
            metadata: frameMetadata(frame),
            failed: false,
          }),
        () =>
          active &&
          !controller.signal.aborted &&
          setLoaded({ key, frame: undefined, failed: true }),
      );
    return () => {
      active = false;
      controller.abort();
    };
  }, [resources, key, projectId, asset.id, revision, requested]);
  useEffect(() => {
    if (requested) resources.cache.promote(key, priority);
  }, [resources, key, requested, priority]);
  useEffect(() => {
    setLoaded((previous) => {
      if (previous.key !== key) return { key, frame: undefined, failed: false };
      return !retained && previous.frame
        ? { ...previous, frame: undefined }
        : previous;
    });
  }, [retained, key]);
  const current =
    loaded.key === key
      ? loaded
      : {
          key,
          frame: retained ? resources.cache.get(key) : undefined,
          failed: false,
        };
  const frame = retained
    ? (current.frame ??
      (requested && !current.failed ? resources.cache.get(key) : undefined))
    : undefined;
  return {
    ...current,
    frame,
    metadata:
      current.metadata ??
      (frame ? frameMetadata(frame) : resources.metadata.get(key)),
  };
}
