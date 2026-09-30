export type FilmstripRequest = { key: string; source: string; time: number };

/** One background decoder, only currently visible work, and a bounded frame cache. */
export class FilmstripCache<T> {
  private frames = new Map<string, T>();
  private failed = new Set<string>();
  private owners = new Map<object, FilmstripRequest[]>();
  private listeners = new Set<() => void>();
  private job: { key: string; abort: AbortController } | null = null;

  constructor(
    private decode: (
      request: FilmstripRequest,
      signal: AbortSignal,
    ) => Promise<T>,
    private capacity = 192,
  ) {}

  get(key: string): T | undefined {
    return this.frames.get(key);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  request(owner: object, requests: FilmstripRequest[]): void {
    this.owners.set(owner, requests);
    for (const { key } of requests) {
      const cached = this.frames.get(key);
      if (cached !== undefined) {
        this.frames.delete(key);
        this.frames.set(key, cached);
      }
    }
    this.reconcile();
  }

  release(owner: object): void {
    this.owners.delete(owner);
    this.reconcile();
  }

  private reconcile(): void {
    // Bound visible work too, preventing an endless decode/evict cycle when
    // there are more tiny visible clips than the cache's frame budget.
    const wanted = [
      ...new Map(
        [...this.owners.values()]
          .flat()
          .map((request) => [request.key, request]),
      ).values(),
    ].slice(0, this.capacity);
    if (this.job) {
      if (!wanted.some(({ key }) => key === this.job?.key))
        this.job.abort.abort();
      return;
    }
    const request = wanted.find(
      ({ key }) => !this.frames.has(key) && !this.failed.has(key),
    );
    if (!request) return;
    const job = { key: request.key, abort: new AbortController() };
    this.job = job;
    void this.decode(request, job.abort.signal)
      .then((frame) => {
        if (job.abort.signal.aborted) return;
        this.frames.set(request.key, frame);
        while (this.frames.size > this.capacity) {
          const oldest = this.frames.keys().next().value;
          if (oldest === undefined) break;
          this.frames.delete(oldest);
        }
        for (const listener of this.listeners) listener();
      })
      .catch(() => {
        if (!job.abort.signal.aborted) {
          this.failed.add(request.key);
          const oldest = this.failed.values().next().value;
          if (this.failed.size > this.capacity && oldest !== undefined)
            this.failed.delete(oldest);
        }
      })
      .finally(() => {
        if (this.job === job) this.job = null;
        this.reconcile();
      });
  }

  clear(): void {
    this.owners.clear();
    this.job?.abort.abort();
    this.frames.clear();
    this.failed.clear();
  }
}
