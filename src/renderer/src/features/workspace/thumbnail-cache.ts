import {
  type ScheduledThumbnail,
  ThumbnailScheduler,
} from './thumbnail-scheduler';

export interface ThumbnailCacheOptions<T> {
  maxActive?: number;
  maxBytes?: number;
  cost?: (frame: T) => number;
  /** Multiple resource caches can share the same decoder limit. */
  scheduler?: ThumbnailScheduler;
}
export interface ThumbnailLoadOptions {
  signal?: AbortSignal;
  priority?: number;
}
interface Consumer<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
  cleanup(): void;
}
interface PendingThumbnail<T> {
  key: string;
  controller: AbortController;
  request: ScheduledThumbnail<T>;
  consumers: Set<Consumer<T>>;
  /** Calls without a signal retain their original shared-promise contract. */
  shared?: Promise<T>;
}
const DEFAULT_BYTES = 64 * 1024 * 1024;
function pixelCost(frame: unknown): number {
  const image = (
    frame as { image?: { width?: unknown; height?: unknown } } | null
  )?.image;
  if (typeof image?.width === 'number' && typeof image.height === 'number')
    return image.width * image.height * 4;
  // Non-pixel clients supply their own cost; keep generic legacy use bounded too.
  return 1;
}

/** Project-scoped frames survive regrouping and undo within a bounded LRU budget. */
export class ThumbnailCache<T> {
  private frames = new Map<string, { frame: T; bytes: number }>();
  private pending = new Map<string, PendingThumbnail<T>>();
  private readonly scheduler: ThumbnailScheduler;
  private readonly cost: (frame: T) => number;
  private readonly maxBytes: number;
  private bytes = 0;

  constructor(options: ThumbnailCacheOptions<T> = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 0)
      throw new RangeError('Invalid thumbnail cache budget');
    this.scheduler =
      options.scheduler ?? new ThumbnailScheduler(options.maxActive);
    this.cost = options.cost ?? pixelCost;
  }
  get(key: string): T | undefined {
    const entry = this.frames.get(key);
    if (!entry) return undefined;
    this.frames.delete(key);
    this.frames.set(key, entry);
    return entry.frame;
  }
  stats() {
    return {
      ...this.scheduler.stats(),
      entries: this.frames.size,
      bytes: this.bytes,
    };
  }

  /** Visibility/focus changes can promote pending work without replacing its consumers. */
  promote(key: string, priority: number): void {
    if (!Number.isFinite(priority))
      throw new RangeError('Invalid thumbnail priority');
    this.pending.get(key)?.request.promote(priority);
  }

  load(
    key: string,
    decode: (signal: AbortSignal) => Promise<T>,
    options: ThumbnailLoadOptions = {},
  ): Promise<T> {
    const { signal, priority = 0 } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!Number.isFinite(priority))
      return Promise.reject(new RangeError('Invalid thumbnail priority'));
    const frame = this.get(key);
    if (frame !== undefined) return Promise.resolve(frame);
    let pending = this.pending.get(key);
    if (!pending) {
      const controller = new AbortController();
      pending = {
        key,
        controller,
        request: this.scheduler.schedule(decode, controller.signal, priority),
        consumers: new Set(),
      };
      this.pending.set(key, pending);
      const current = pending;
      void current.request.promise.then(
        (result) => {
          if (
            this.pending.get(key) !== current ||
            current.controller.signal.aborted
          )
            return;
          try {
            this.remember(key, result);
            this.finish(current, { frame: result });
          } catch (error) {
            this.finish(current, { error });
          }
        },
        (error: unknown) => this.finish(current, { error }),
      );
    } else pending.request.promote(priority);
    if (!signal && pending.shared) return pending.shared;
    const current = pending;
    const promise = new Promise<T>((resolve, reject) => {
      const consumer: Consumer<T> = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', abort),
      };
      const abort = () => {
        if (!current.consumers.delete(consumer)) return;
        consumer.cleanup();
        reject(signal?.reason);
        if (!current.consumers.size) this.cancel(current, signal?.reason);
      };
      current.consumers.add(consumer);
      signal?.addEventListener('abort', abort, { once: true });
    });
    if (!signal) current.shared = promise;
    return promise;
  }
  clear(): void {
    const error = new DOMException('Thumbnail cache cleared', 'AbortError');
    for (const pending of [...this.pending.values()])
      this.cancel(pending, error);
    this.frames.clear();
    this.bytes = 0;
  }
  private cancel(pending: PendingThumbnail<T>, error: unknown) {
    this.finish(pending, { error });
    pending.controller.abort(error);
  }
  private finish(
    pending: PendingThumbnail<T>,
    outcome: { frame: T } | { error: unknown },
  ) {
    if (this.pending.get(pending.key) === pending)
      this.pending.delete(pending.key);
    for (const consumer of pending.consumers) {
      consumer.cleanup();
      if ('error' in outcome) consumer.reject(outcome.error);
      else consumer.resolve(outcome.frame);
    }
    pending.consumers.clear();
  }
  private remember(key: string, frame: T) {
    const bytes = Math.ceil(this.cost(frame));
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new RangeError('Invalid thumbnail pixel cost');
    // Oversized frames still reach consumers without being retained in the cache.
    if (!this.maxBytes || bytes > this.maxBytes) return;
    this.frames.set(key, { frame, bytes });
    this.bytes += bytes;
    while (this.bytes > this.maxBytes) {
      const oldest = this.frames.entries().next().value;
      if (!oldest) break;
      this.frames.delete(oldest[0]);
      this.bytes -= oldest[1].bytes;
    }
    // Drop only our reference: mounted canvases may still use these same pixels.
  }
}
