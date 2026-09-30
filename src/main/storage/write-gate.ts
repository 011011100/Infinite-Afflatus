/** Serializes project writes. Migration closes admission before waiting for existing writes. */
export class WriteGate {
  private tail: Promise<unknown> = Promise.resolve();
  private blocked = false;
  private available = new Set<() => void>();

  get isBlocked(): boolean {
    return this.blocked;
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.blocked)
      return Promise.reject(new Error('项目目录正在迁移，请稍后保存'));
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async block(): Promise<void> {
    if (this.blocked) throw new Error('已有目录任务正在运行');
    this.blocked = true;
    await this.tail;
  }

  release(): void {
    this.blocked = false;
    for (const listener of this.available) listener();
    this.available.clear();
  }
  /** Background derived media may finish during migration; resolve its path only after admission. */
  async whenOpen<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    while (this.blocked) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          this.available.delete(ready);
          signal.removeEventListener('abort', abort);
        };
        const ready = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        this.available.add(ready);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    signal.throwIfAborted();
    return this.run(operation);
  }
  async idle(): Promise<void> {
    await this.tail;
  }
}
