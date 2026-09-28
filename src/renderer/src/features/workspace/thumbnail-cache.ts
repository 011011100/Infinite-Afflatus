/** Project-scoped decoded frames survive card regrouping and undo/redo. */
export class ThumbnailCache<T> {
  private frames = new Map<string, T>();
  private pending = new Map<
    string,
    { controller: AbortController; promise: Promise<T> }
  >();

  get(key: string): T | undefined {
    return this.frames.get(key);
  }

  load(key: string, decode: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const frame = this.frames.get(key);
    if (frame !== undefined) return Promise.resolve(frame);
    const pending = this.pending.get(key);
    if (pending) return pending.promise;
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return decode(controller.signal);
      })
      .then((result) => {
        controller.signal.throwIfAborted();
        this.frames.set(key, result);
        return result;
      })
      .finally(() => {
        if (this.pending.get(key)?.controller === controller)
          this.pending.delete(key);
      });
    this.pending.set(key, { controller, promise });
    return promise;
  }

  clear(): void {
    for (const { controller } of this.pending.values()) controller.abort();
    this.pending.clear();
    this.frames.clear();
  }
}
