import { use, useEffect, useState } from 'react';
import type { Asset } from '../../../../../shared/models';
import { mediaUrl } from '../media';
import { ThumbnailContext } from '../thumbnail-provider';
import { mediaRevision, useMediaRevision } from '../use-media-revision';
import type { VideoMetadata } from '../video-metadata';

/** Full sequence duration/aspect data contains no pixel canvases. */
export function useSequenceFrames(projectId: string, assets: Asset[]) {
  const revision = useMediaRevision(projectId);
  const context = use(ThumbnailContext);
  if (!context) throw new Error('ThumbnailProvider is missing');
  const resources = context;
  const [frames, setFrames] = useState<Map<string, VideoMetadata> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    // Retry token intentionally restarts failed metadata reads.
    void attempt;
    void revision;
    let active = true;
    const controller = new AbortController();
    setError(null);
    const result = new Map<string, VideoMetadata>();
    async function load() {
      // Metadata-only readers share the global three-slot thumbnail scheduler.
      for (let index = 0; index < assets.length; index += 3) {
        if (!active) return;
        await Promise.all(
          assets.slice(index, index + 3).map(async (asset) => {
            const assetRevision = mediaRevision(projectId, asset.id);
            const frame = await resources.loadMetadata(
              `${projectId}/${asset.id}/${asset.sha256}/${assetRevision}`,
              mediaUrl(projectId, asset.id, assetRevision),
              controller.signal,
            );
            if (!frame?.duration || !Number.isFinite(frame.duration))
              throw new Error(`无法读取 ${asset.name} 的时长`);
            result.set(asset.id, frame);
          }),
        );
      }
      if (active) setFrames(result);
    }
    void load().catch((reason: unknown) => {
      if (active)
        setError(reason instanceof Error ? reason.message : '读取视频失败');
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [resources, projectId, assets, attempt, revision]);
  return { frames, error, retry: () => setAttempt((value) => value + 1) };
}
