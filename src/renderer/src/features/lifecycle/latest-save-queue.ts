/** Serialize replaceable state such as a viewport, retaining the newest value after failure. */
export class LatestSaveQueue<T> {
  private latest: { value: T; revision: number } | null = null;
  private saved = 0;
  private pending: Promise<boolean> | null = null;

  constructor(
    private readonly write: (value: T) => Promise<void>,
    private readonly canWrite: () => boolean = () => true,
  ) {}

  update(value: T): Promise<boolean> {
    this.latest = { value, revision: (this.latest?.revision ?? 0) + 1 };
    return this.flush();
  }

  flush = (): Promise<boolean> => {
    if (this.pending) return this.pending;
    if (!this.latest || this.saved === this.latest.revision)
      return Promise.resolve(true);
    if (!this.canWrite()) return Promise.resolve(false);
    this.pending = this.drain().finally(() => {
      this.pending = null;
    });
    return this.pending;
  };

  private async drain(): Promise<boolean> {
    try {
      while (this.latest && this.saved !== this.latest.revision) {
        if (!this.canWrite()) return false;
        const next = this.latest;
        await this.write(next.value);
        this.saved = next.revision;
      }
      return true;
    } catch {
      return false;
    }
  }
}
