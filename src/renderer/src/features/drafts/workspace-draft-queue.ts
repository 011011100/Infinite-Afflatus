import type { DesktopBridge } from '../../../../shared/desktop';
import type { GenerationWorkspace } from '../../../../shared/generation/workspace';
import {
  sameWorkspace,
  type WorkspaceDraftInput,
  type WorkspaceDraftKey,
} from '../../../../shared/workspace-draft';

type Desktop = Pick<
  DesktopBridge,
  'protectWorkspaceDraft' | 'acknowledgeWorkspaceDraft'
>;

/** Immediate, coalesced snapshots: continuous typing never resets a trailing timer. */
export class WorkspaceDraftQueue {
  private latest: WorkspaceDraftInput | null = null;
  private protectedSeq = 0;
  private running: Promise<boolean> | null = null;
  private submitted: GenerationWorkspace | undefined;
  private waiters = new Set<{
    seq: number;
    resolve: (saved: boolean) => void;
  }>();
  private listeners = new Set<() => void>();
  private state = { saving: false, error: null as string | null };
  constructor(
    readonly projectId: string,
    readonly sessionId: string,
    private readonly desktop: Desktop,
  ) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit(next: Partial<typeof this.state>) {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((listener) => {
      listener();
    });
  }
  snapshot = () => this.latest;
  prepareSubmission(
    baseline: GenerationWorkspace,
    workspace: GenerationWorkspace,
  ) {
    this.submitted = {
      ...structuredClone(workspace),
      revision: baseline.revision + 1,
    };
    return this.stage(baseline, workspace);
  }
  confirm(baseline: GenerationWorkspace, workspace: GenerationWorkspace) {
    this.submitted = undefined;
    return this.stage(baseline, workspace);
  }
  stage(
    baseline: GenerationWorkspace,
    workspace: GenerationWorkspace,
  ): WorkspaceDraftKey {
    if (
      !this.latest ||
      !sameWorkspace(this.latest.baseline, baseline) ||
      !sameWorkspace(this.latest.workspace, workspace) ||
      JSON.stringify(this.latest.lastSubmitted) !==
        JSON.stringify(this.submitted)
    ) {
      this.latest = {
        sessionId: this.sessionId,
        seq: (this.latest?.seq ?? 0) + 1,
        baseline: structuredClone(baseline),
        workspace: structuredClone(workspace),
        ...(this.submitted
          ? { lastSubmitted: structuredClone(this.submitted) }
          : {}),
      };
    }
    void this.flush();
    return { sessionId: this.sessionId, seq: this.latest.seq };
  }
  flush = (): Promise<boolean> => {
    if (!this.latest || this.protectedSeq === this.latest.seq)
      return Promise.resolve(true);
    const seq = this.latest.seq;
    const waiting = new Promise<boolean>((resolve) =>
      this.waiters.add({ seq, resolve }),
    );
    if (!this.running) {
      this.emit({ saving: true });
      this.running = this.drain().finally(() => {
        this.running = null;
        this.emit({ saving: false });
        if (this.state.error) this.resolveWaiters(false);
        else if (this.latest && this.latest.seq > this.protectedSeq)
          void this.flush();
      });
    }
    return waiting;
  };
  private resolveWaiters(success: boolean) {
    for (const waiter of this.waiters) {
      if (!success || waiter.seq <= this.protectedSeq) {
        this.waiters.delete(waiter);
        waiter.resolve(success);
      }
    }
  }
  private async drain() {
    try {
      while (this.latest && this.protectedSeq !== this.latest.seq) {
        const next = this.latest;
        await this.desktop.protectWorkspaceDraft(this.projectId, next);
        this.protectedSeq = next.seq;
        this.resolveWaiters(true);
      }
      this.emit({ error: null });
      return true;
    } catch {
      this.emit({
        error:
          '镜头恢复副本未更新；普通项目保存仍会继续。意外退出可能丢失尚未保存的内容，可重试或导出恢复文件。',
      });
      this.resolveWaiters(false);
      return false;
    }
  }
  async acknowledge(key: WorkspaceDraftKey) {
    try {
      await this.desktop.acknowledgeWorkspaceDraft(this.projectId, key);
    } catch {
      // Never claim a failed project acknowledgement or recovery cleanup succeeded.
      this.emit({
        error: '项目已保存，但恢复副本尚未确认。副本仍保留，重启后会重新检查。',
      });
    }
  }
}
