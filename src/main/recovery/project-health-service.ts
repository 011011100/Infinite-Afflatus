import { dirname } from 'node:path';
import type {
  ProjectHealthMode,
  ProjectHealthProgress,
  ProjectHealthReport,
} from '../../shared/project-health';
import { verifyProjectDatabase } from '../projects/project-database';
import type { ProjectService } from '../projects/project-service';
import type { AppStore } from '../storage/app-store';
import type { WriteGate } from '../storage/write-gate';
import { inspectAsset } from './asset-inspection';
import { RepairWork } from './repair-work';
import { restoreAsset } from './restore-asset';

/** Exact-byte restoration only. No project metadata, source file or existing destination is changed. */
export class ProjectHealthService {
  private readonly work: RepairWork;
  private running: Promise<unknown> | null = null;
  private controller: AbortController | null = null;
  private closing = false;
  private cancellationEpoch = 0;
  private listeners = new Set<(state: ProjectHealthProgress | null) => void>();
  private lastProgress = 0;

  constructor(
    private readonly projects: ProjectService,
    store: AppStore,
    private readonly gate: WriteGate,
    private readonly userData: string,
  ) {
    this.work = new RepairWork(store);
  }

  subscribe(listener: (state: ProjectHealthProgress | null) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  recover(): Promise<void> {
    return this.work.clean();
  }
  /** Native dialogs share cancellation with scans, restores and shutdown. */
  get cancellationVersion() {
    return this.cancellationEpoch;
  }
  cancel(): void {
    this.cancellationEpoch++;
    this.controller?.abort(new Error('素材检查或恢复已取消'));
  }
  async close() {
    this.closing = true;
    this.cancel();
    await this.running?.catch(() => undefined);
  }

  scan(
    projectId: string,
    mode: ProjectHealthMode,
  ): Promise<ProjectHealthReport> {
    if (mode !== 'quick' && mode !== 'full')
      return Promise.reject(new Error('无效的素材检查模式'));
    return this.run((signal) => this.inspect(projectId, mode, signal));
  }

  restore(
    projectId: string,
    assetId: string,
    source: string,
    beforeRestore?: () => Promise<void>,
  ): Promise<ProjectHealthReport> {
    return this.run(async (signal) => {
      // Native retained-copy consent is revalidated after admission to the
      // write gate, never against a snapshot taken before queued work finishes.
      await beforeRestore?.();
      signal.throwIfAborted();
      await restoreAsset(
        this.projects,
        this.work,
        this.userData,
        projectId,
        assetId,
        source,
        signal,
        (state) => this.emit(state),
      );
      // Publication already committed; cancellation must not undo a successfully restored asset.
      return this.inspect(
        projectId,
        'quick',
        new AbortController().signal,
        false,
      );
    });
  }

  private async inspect(
    projectId: string,
    mode: ProjectHealthMode,
    signal: AbortSignal,
    publish = true,
  ): Promise<ProjectHealthReport> {
    const snapshot = await this.projects.open(projectId);
    const database = await this.projects.databasePath(projectId);
    verifyProjectDatabase(database);
    const report: ProjectHealthReport = {
      projectId,
      mode,
      checkedAt: new Date().toISOString(),
      assetCount: snapshot.assets.length,
      issues: [],
    };
    const total = snapshot.assets.reduce(
      (sum, asset) =>
        sum + Math.max(1, Number.isSafeInteger(asset.size) ? asset.size : 1),
      0,
    );
    let checked = 0;
    for (const asset of snapshot.assets) {
      signal.throwIfAborted();
      const progress = (bytes: number) => {
        if (publish)
          this.emit({
            projectId,
            operation: 'scan',
            progress: Math.min(1, (checked + bytes) / Math.max(1, total)),
            assetName: asset.name,
          });
      };
      progress(0);
      const issue = await inspectAsset(
        dirname(database),
        asset,
        mode,
        signal,
        progress,
      );
      if (issue) report.issues.push(issue);
      checked += Math.max(1, Number.isSafeInteger(asset.size) ? asset.size : 1);
    }
    signal.throwIfAborted();
    if (publish)
      this.emit({ projectId, operation: 'scan', progress: 1, assetName: null });
    return report;
  }

  private run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('应用正在关闭'));
    if (this.running)
      return Promise.reject(
        new Error('已有素材检查或恢复正在进行，请等待或取消'),
      );
    const controller = new AbortController();
    this.controller = controller;
    this.lastProgress = 0;
    const pending = this.gate
      .run(async () => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      })
      .finally(() => {
        this.running = null;
        this.controller = null;
        this.emit(null);
      });
    this.running = pending;
    return pending;
  }

  private emit(state: ProjectHealthProgress | null) {
    const now = Date.now();
    if (state && state.progress !== 1 && now - this.lastProgress < 100) return;
    this.lastProgress = now;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (error) {
        console.error('Project health observer failed:', error);
      }
    }
  }
}
