import { use, useEffect, useState } from 'react';
import type { Asset } from '../../../../../shared/models';
import { decodeThumbnail, type ThumbnailFrame } from '../decode-thumbnail';
import { mediaUrl } from '../media';
import { ThumbnailContext } from '../thumbnail-provider';

/** Reuse decoded canvas thumbnails; opening the editor does not decode every source again. */
export function useSequenceFrames(projectId: string, assets: Asset[]) {
  const cache = use(ThumbnailContext);
  if (!cache) throw new Error('ThumbnailProvider is missing');
  const [frames, setFrames] = useState<Map<string, ThumbnailFrame> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    // Retry token intentionally restarts failed metadata reads.
    void attempt;
    let active = true;
    setError(null);
    const result = new Map<string, ThumbnailFrame>();
    async function load() {
      // Bound new decoders for long sequences. Cache coalesces canvas requests.
      for (let index = 0; index < assets.length; index += 3) {
        if (!active) return;
        await Promise.all(
          assets.slice(index, index + 3).map(async (asset) => {
            const frame = await cache?.load(
              `${projectId}/${asset.id}/${asset.sha256}`,
              (signal) =>
                decodeThumbnail(mediaUrl(projectId, asset.id), signal),
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
    };
  }, [cache, projectId, assets, attempt]);
  return { frames, error, retry: () => setAttempt((value) => value + 1) };
}
