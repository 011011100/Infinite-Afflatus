type PendingSave = {
  label: string;
  flush: () => Promise<boolean>;
  priority: number;
  capturePending?: () => Promise<boolean> | null;
};

/** Each editor owns its draft; navigation only needs to know whether all drafts landed. */
export class PendingSaves {
  private entries = new Set<PendingSave>();
  private pending: Promise<boolean> | null = null;

  register(
    label: string,
    flush: () => Promise<boolean>,
    priority = 0,
    capturePending?: () => Promise<boolean> | null,
  ): () => void {
    const entry = {
      label,
      flush,
      priority,
      ...(capturePending ? { capturePending } : {}),
    };
    this.entries.add(entry);
    return () => {
      this.entries.delete(entry);
    };
  }

  /** Observe work already in flight without starting writes behind a busy gate. */
  capturePending = (): Promise<boolean> => {
    const captured: Promise<boolean>[] = [];
    for (const entry of this.entries) {
      try {
        const operation = entry.capturePending?.();
        if (operation) captured.push(operation);
      } catch {
        captured.push(Promise.resolve(false));
      }
    }
    return Promise.allSettled(captured).then((results) =>
      results.every((result) => result.status === 'fulfilled' && result.value),
    );
  };

  flush = (): Promise<boolean> => {
    if (this.pending) return this.pending;
    this.pending = this.drain().finally(() => {
      this.pending = null;
    });
    return this.pending;
  };

  private async drain(): Promise<boolean> {
    let saved = true;
    // A failed editor must not prevent the other independent drafts from saving.
    for (const entry of [...this.entries].sort(
      (a, b) => a.priority - b.priority,
    )) {
      if (!this.entries.has(entry)) continue;
      try {
        if (!(await entry.flush())) saved = false;
      } catch (error) {
        console.error(`Unable to save ${entry.label}:`, error);
        saved = false;
      }
    }
    return saved;
  }
}

export const pendingSaves = new PendingSaves();
export const flushPendingChanges = pendingSaves.flush;
export const capturePendingSaves = pendingSaves.capturePending;
