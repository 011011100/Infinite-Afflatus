import { randomUUID } from 'node:crypto';

/** One nonce-bound request per window; stale or foreign replies cannot authorize a close. */
export class SaveRequest<T extends object> {
  private pending: {
    target: T;
    token: string;
    promise: Promise<boolean>;
    finish: (saved: boolean) => void;
  } | null = null;

  constructor(
    private readonly send: (target: T, token: string) => void,
    private readonly timeout: (target: T) => void,
    private readonly timeoutMs = 30_000,
  ) {}

  request(target: T): Promise<boolean> {
    if (this.pending) return this.pending.promise;
    const token = randomUUID();
    let finish!: (saved: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const timer = setTimeout(() => {
      this.pending?.finish(false);
      this.timeout(target);
    }, this.timeoutMs);
    this.pending = {
      target,
      token,
      promise,
      finish: (saved) => {
        clearTimeout(timer);
        this.pending = null;
        finish(saved);
      },
    };
    try {
      this.send(target, token);
    } catch {
      this.pending.finish(false);
      this.timeout(target);
    }
    return promise;
  }

  acknowledge(target: T, token: unknown, saved: unknown): void {
    if (
      !this.pending ||
      this.pending.target !== target ||
      this.pending.token !== token ||
      typeof saved !== 'boolean'
    )
      throw new Error('Invalid save acknowledgement');
    this.pending.finish(saved);
  }
}
