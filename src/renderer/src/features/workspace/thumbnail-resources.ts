import { decodeThumbnail, type ThumbnailFrame } from './decode-thumbnail';
import { ThumbnailCache } from './thumbnail-cache';
import { ThumbnailScheduler } from './thumbnail-scheduler';
import { ThumbnailVisibility } from './thumbnail-visibility';
import { readVideoMetadata, type VideoMetadata } from './video-metadata';

export function frameMetadata(frame: ThumbnailFrame): VideoMetadata {
  return {
    duration: frame.duration,
    width: frame.image.width,
    height: frame.image.height,
  };
}

/** The 64 MiB budget covers cache ownership, not visible canvases or transition leases. */
export class ThumbnailResources {
  private readonly scheduler = new ThumbnailScheduler();
  readonly cache = new ThumbnailCache<ThumbnailFrame>({
    scheduler: this.scheduler,
  });
  readonly metadata = new ThumbnailCache<VideoMetadata>({
    scheduler: this.scheduler,
    maxBytes: 1024 * 1024,
    cost: () => 64,
  });
  readonly visibility = new ThumbnailVisibility();

  constructor(
    private readonly decode = decodeThumbnail,
    private readonly readMetadata = readVideoMetadata,
  ) {}

  load(key: string, source: string, signal: AbortSignal, priority: number) {
    return this.cache.load(
      key,
      (sharedSignal) => this.decode(source, sharedSignal),
      { signal, priority },
    );
  }

  loadMetadata(
    key: string,
    source: string,
    signal: AbortSignal,
  ): Promise<VideoMetadata> {
    const frame = this.cache.get(key);
    const metadata = frame ? frameMetadata(frame) : undefined;
    return this.metadata.load(
      key,
      (sharedSignal) =>
        metadata
          ? Promise.resolve(metadata)
          : this.readMetadata(source, sharedSignal),
      { signal, priority: 2 },
    );
  }

  clear() {
    this.cache.clear();
    this.metadata.clear();
    this.visibility.clear();
  }
}
