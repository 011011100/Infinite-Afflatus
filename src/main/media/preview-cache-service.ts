import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import type {
  PreviewCacheCleanupPreview,
  PreviewCacheCleanupResult,
  PreviewCacheInspection,
} from '../../shared/preview-cache';
import type { ProjectService } from '../projects/project-service';
import type { AppStore } from '../storage/app-store';
import { errorMessage } from '../storage/database';
import type { WriteGate } from '../storage/write-gate';
import {
  type CacheCandidate,
  PreviewCacheInspectionService,
} from './preview-cache-inspection';
import type { ProxyService } from './proxy-service';

/** Expiring, single-use confirmation of a fixed, revalidated list. Never recursively removes. */
export class PreviewCacheService {
  private inspection: PreviewCacheInspectionService;
  private previewed: {
    token: string;
    expires: number;
    files: CacheCandidate[];
  } | null = null;
  private running = new Set<{
    controller: AbortController;
    promise: Promise<unknown>;
  }>();
  private closed = false;
  private revision = 0;

  constructor(
    projects: ProjectService,
    private gate: WriteGate,
    store: AppStore,
    proxies: ProxyService,
    private available: () => void = () => undefined,
    private clock: () => number = Date.now,
    private remove: (file: string) => void = unlinkSync,
  ) {
    this.inspection = new PreviewCacheInspectionService(
      projects,
      store,
      proxies,
      () => this.assertAvailable(),
    );
  }

  inspect(): Promise<PreviewCacheInspection> {
    this.invalidate();
    return this.run(async (signal) => {
      const scan = await this.inspection.scan(signal);
      signal.throwIfAborted();
      this.assertAvailable();
      return {
        items: scan.items,
        bytes: scan.items.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
        eligibleCount: scan.candidates.length,
        eligibleBytes: scan.candidates.reduce(
          (sum, file) => sum + file.proxy.facts.size,
          0,
        ),
        incomplete: scan.incomplete,
      };
    });
  }

  preview(): Promise<PreviewCacheCleanupPreview> {
    this.invalidate();
    const revision = this.revision;
    return this.run(async (signal) => {
      const scan = await this.inspection.scan(signal);
      signal.throwIfAborted();
      this.assertAvailable();
      if (revision !== this.revision)
        throw new Error('此检查已被更新的检查替代');
      const expires = this.clock() + 120_000;
      const token = scan.candidates.length ? randomUUID() : null;
      this.previewed = token
        ? { token, expires, files: scan.candidates }
        : null;
      return {
        token,
        expiresAt: token ? new Date(expires).toISOString() : null,
        files: scan.candidates.map((file) => file.item),
        bytes: scan.candidates.reduce(
          (sum, file) => sum + file.proxy.facts.size,
          0,
        ),
        retained: scan.items.filter((item) => !item.canCleanup),
        incomplete: scan.incomplete,
      };
    });
  }

  execute(token: string): Promise<PreviewCacheCleanupResult> {
    const preview = this.previewed;
    this.invalidate();
    if (!preview || preview.token !== token || preview.expires <= this.clock())
      return Promise.reject(new Error('清理确认已失效，请重新检查预览缓存'));
    return this.run(async (signal) => {
      if (preview.expires <= this.clock())
        throw new Error('清理确认已过期，请重新检查');
      const result: PreviewCacheCleanupResult = {
        removedCount: 0,
        removedBytes: 0,
        retained: [],
        cancelled: false,
      };
      for (const expected of preview.files) {
        try {
          // A failure affects only this confirmed file; never expands the selection.
          const current = await this.inspection.revalidate(expected, signal);
          this.inspection.checkCurrent(current, signal);
          // No async gap: editor admission and protocol acquisition use this same gate.
          this.remove(current.proxy.file);
          result.removedCount++;
          result.removedBytes += current.proxy.facts.size;
          // Keep manifest history. Missing derived files are already ignored by migration
          // and ensure() regenerates them; no crash-prone database/file two-phase delete.
        } catch (error) {
          result.retained.push({
            ...expected.item,
            canCleanup: false,
            reason: errorMessage(error),
          });
        }
      }
      result.cancelled = signal.aborted;
      return result;
    });
  }

  cancel(): void {
    this.invalidate();
    for (const operation of this.running)
      operation.controller.abort(
        new DOMException('预览缓存检查或清理已取消', 'AbortError'),
      );
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancel();
    await Promise.allSettled(
      [...this.running].map((operation) => operation.promise),
    );
  }

  private invalidate(): void {
    this.revision++;
    this.previewed = null;
  }

  private assertAvailable(): void {
    if (this.closed) throw new Error('应用正在关闭，已保留预览缓存');
    this.available();
    if (this.gate.isBlocked) throw new Error('目录正在迁移，已保留预览缓存');
  }

  private run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      this.assertAvailable();
    } catch (error) {
      return Promise.reject(error);
    }
    const controller = new AbortController();
    const promise = this.gate
      .run(async () => {
        controller.signal.throwIfAborted();
        this.assertAvailable();
        return operation(controller.signal);
      })
      .finally(() => this.running.delete(record));
    const record = { controller, promise };
    this.running.add(record);
    return promise;
  }
}
