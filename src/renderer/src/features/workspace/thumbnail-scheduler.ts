export interface ScheduledThumbnail<T> {
  promise: Promise<T>;
  promote(priority: number): void;
}

interface ScheduledWork {
  priority: number;
  order: number;
  start(): void;
}

/** Cancellation releases a request immediately, but a decoder owns its slot until it settles. */
export class ThumbnailScheduler {
  private queue: ScheduledWork[] = [];
  private active = 0;
  private order = 0;
  private scheduled = false;

  constructor(private readonly maxActive = 3) {
    if (!Number.isInteger(maxActive) || maxActive < 1 || maxActive > 3)
      throw new RangeError('Thumbnail concurrency must be between 1 and 3');
  }

  stats() {
    return { active: this.active, queued: this.queue.length };
  }

  schedule<T>(
    decode: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
    priority = 0,
  ): ScheduledThumbnail<T> {
    if (!Number.isFinite(priority))
      throw new RangeError('Invalid thumbnail priority');
    let work: ScheduledWork;
    const promise = new Promise<T>((resolve, reject) => {
      let started = false;
      let settled = false;
      const abort = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        if (!started) this.queue = this.queue.filter((item) => item !== work);
        reject(signal.reason);
        this.requestPump();
      };
      work = {
        priority,
        order: this.order++,
        start: () => {
          started = true;
          this.active++;
          let decoding: Promise<T>;
          try {
            signal.throwIfAborted();
            decoding = decode(signal);
          } catch (error) {
            decoding = Promise.reject(error);
          }
          void Promise.resolve(decoding)
            .then(
              (frame) => {
                if (!settled) {
                  settled = true;
                  resolve(frame);
                }
              },
              (error: unknown) => {
                if (!settled) {
                  settled = true;
                  reject(error);
                }
              },
            )
            .finally(() => {
              signal.removeEventListener('abort', abort);
              this.active--;
              this.requestPump();
            });
        },
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      this.queue.push(work);
      this.requestPump();
    });
    return {
      promise,
      promote: (next) => {
        if (!Number.isFinite(next))
          throw new RangeError('Invalid thumbnail priority');
        work.priority = Math.max(work.priority, next);
      },
    };
  }

  private requestPump() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.queue.sort((a, b) => b.priority - a.priority || a.order - b.order);
      while (this.active < this.maxActive && this.queue.length)
        this.queue.shift()?.start();
    });
  }
}
