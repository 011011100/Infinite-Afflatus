import type { App, Event } from 'electron';

/** Owns only startup: no late native response may start disk work after quit. */
export class StartupLifetime {
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private stopping: Promise<void> | null = null;
  readonly signal = this.controller.signal;

  constructor(
    private readonly host: Pick<App, 'on' | 'removeListener' | 'quit' | 'exit'>,
    private readonly close: () => Promise<void>,
  ) {
    host.on('before-quit', this.beforeQuit);
  }

  track<T>(operation: () => Promise<T>): Promise<T> {
    this.signal.throwIfAborted();
    const pending = operation();
    this.pending.add(pending);
    return pending.finally(() => this.pending.delete(pending));
  }

  detach(): void {
    this.host.removeListener('before-quit', this.beforeQuit);
  }

  private readonly beforeQuit = (event: Event) => {
    event.preventDefault();
    if (this.stopping) return;
    this.controller.abort(new Error('应用正在退出'));
    this.stopping = this.stop();
  };

  private async stop(): Promise<void> {
    // close signals cancellation immediately. Only started storage operations
    // are awaited; a native picker can remain unresolved until Electron exits.
    const results = await Promise.allSettled([this.close(), ...this.pending]);
    this.detach();
    const closeResult = results[0];
    if (closeResult?.status === 'rejected') {
      console.error('Startup shutdown failed:', closeResult.reason);
      this.host.exit(1);
    } else this.host.quit();
  }
}
