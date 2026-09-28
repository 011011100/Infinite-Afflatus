/** Serializes project writes. Migration closes admission before waiting for existing writes. */
export class WriteGate {
  private tail: Promise<unknown> = Promise.resolve();
  private blocked = false;

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
  }
  async idle(): Promise<void> {
    await this.tail;
  }
}
