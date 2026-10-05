import { randomUUID } from 'node:crypto';
import type {
  ProjectPackageOperation,
  ProjectPackageProgress,
} from '../../shared/project-package';
import {
  PackageCancelledError,
  type ProjectPackageControls,
} from './package-progress';
import type { ProjectPackageService } from './project-package-service';

interface ActiveRequest {
  owner: number;
  requestId: string;
  controller: AbortController;
  done: Promise<unknown>;
  progress: ProjectPackageProgress;
  report(change: Partial<ProjectPackageProgress>, force?: boolean): void;
}

/** Owns chooser-to-cleanup requests. The file service retains its independent, historical API. */
export class PackageRequests {
  private active: ActiveRequest | null = null;
  private pauses = new Map<string, number>();
  private closing: Promise<void> | null = null;
  constructor(
    private readonly service: Pick<ProjectPackageService, 'cancel'>,
  ) {}

  run<Selection, Result>(
    owner: number,
    requestId: string,
    operation: ProjectPackageOperation,
    projectId: string | null,
    choose: () => Promise<Selection | null>,
    execute: (
      selection: Selection,
      controls: ProjectPackageControls,
    ) => Promise<Result>,
    onProgress?: (progress: ProjectPackageProgress) => void,
  ): Promise<Result | null> {
    if (this.closing)
      return Promise.reject(new Error('应用正在关闭，无法处理项目包'));
    if ([...this.pauses.values()].includes(owner)) return Promise.resolve(null);
    if (this.active)
      return Promise.reject(
        new Error('已有项目包任务正在运行，请等待完成或取消'),
      );
    let resolve!: (value: Result | null) => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<Result | null>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    let lastReport = -Infinity;
    let previous: ProjectPackageProgress | null = null;
    const work: ActiveRequest = {
      owner,
      requestId,
      controller: new AbortController(),
      done,
      progress: {
        requestId,
        projectId,
        operation,
        phase: 'choosing',
        completedBytes: 0,
        totalBytes: null,
        completedFiles: 0,
        totalFiles: null,
        fileName: null,
        canCancel: true,
      },
      report(change, force = false) {
        const progress = { ...work.progress, ...change };
        const terminal = ['completed', 'cancelled', 'failed'].includes(
          progress.phase,
        );
        if (work.controller.signal.aborted && !terminal && progress.canCancel) {
          progress.phase = 'cancelling';
          progress.canCancel = false;
        }
        work.progress = progress;
        const now = performance.now();
        if (
          !force &&
          previous &&
          previous.phase === progress.phase &&
          previous.fileName === progress.fileName &&
          previous.completedFiles === progress.completedFiles &&
          previous.canCancel === progress.canCancel &&
          !(previous.completedBytes === 0 && progress.completedBytes > 0) &&
          now - lastReport < 200
        )
          return;
        previous = progress;
        lastReport = now;
        try {
          onProgress?.({ ...progress });
        } catch {
          /* Detached UI is not a storage failure. */
        }
      },
    };
    this.active = work;
    // Register before any chooser or observer callback, including synchronous cancellation.
    void Promise.resolve()
      .then(async () => {
        work.report({}, true);
        try {
          const selected = await this.choose(work.controller.signal, choose);
          if (selected === null || work.controller.signal.aborted) {
            work.report({ phase: 'cancelled', canCancel: false }, true);
            return null;
          }
          const result = await execute(selected, {
            signal: work.controller.signal,
            onProgress: (progress) => work.report(progress),
          });
          // A successfully published result wins over a cancellation arriving during final cleanup.
          work.report({ phase: 'completed', canCancel: false }, true);
          return result;
        } catch (error) {
          const cancelled = error instanceof PackageCancelledError;
          work.report(
            { phase: cancelled ? 'cancelled' : 'failed', canCancel: false },
            true,
          );
          if (cancelled) return null;
          throw error;
        } finally {
          if (this.active === work) this.active = null;
        }
      })
      .then(resolve, reject);
    return done;
  }

  cancel(owner: number, requestId?: string): Promise<void> {
    const work = this.active;
    if (
      !work ||
      work.owner !== owner ||
      (requestId !== undefined && requestId !== work.requestId)
    )
      return Promise.resolve();
    this.abort(work);
    return work.done.then(() => undefined);
  }
  async prepareForLeave(owner: number): Promise<string> {
    if (this.closing) throw new Error('应用正在关闭');
    const token = randomUUID();
    this.pauses.set(token, owner);
    try {
      await this.cancel(owner);
      return token;
    } catch (error) {
      this.pauses.delete(token);
      throw error;
    }
  }
  resumeAfterLeave(owner: number, token: string): void {
    const saved = this.pauses.get(token);
    if (saved === undefined) return;
    if (saved !== owner) throw new Error('无法恢复其他窗口的项目包操作');
    if (!this.closing) this.pauses.delete(token);
  }
  resumeOwner(owner: number): void {
    for (const [token, saved] of this.pauses)
      if (saved === owner) this.resumeAfterLeave(owner, token);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const work = this.active;
    this.closing = Promise.resolve().then(async () => {
      await work?.done;
    });
    if (work) this.abort(work);
    this.service.cancel();
    return this.closing;
  }
  private abort(work: ActiveRequest) {
    if (
      work.controller.signal.aborted ||
      ['completed', 'cancelled', 'failed'].includes(work.progress.phase)
    )
      return;
    work.controller.abort(new PackageCancelledError());
    if (work.progress.canCancel)
      work.report({ phase: 'cancelling', canCancel: false }, true);
  }
  private async choose<T>(
    signal: AbortSignal,
    choose: () => Promise<T | null>,
  ): Promise<T | null> {
    if (signal.aborted) return null;
    let abort!: () => void;
    const cancelled = new Promise<null>((resolve) => {
      abort = () => resolve(null);
    });
    signal.addEventListener('abort', abort, { once: true });
    try {
      return await Promise.race([choose(), cancelled]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
}
