import { randomUUID } from 'node:crypto';
import { lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { SaveJob } from '../../shared/models';
import type {
  StagingCleanupPreview,
  StagingCleanupResult,
  StagingInspection,
  StagingItem,
} from '../../shared/staging-cleanup';
import type { AppStore } from '../storage/app-store';
import { errorMessage } from '../storage/database';
import { fingerprint, sameContent, syncDirectory } from '../storage/files';
import { STAGING_CANCELLED, type Staging } from './staging';
import {
  type PartFingerprint,
  type PartOwnership,
  partFingerprint,
  sameIdentity,
  samePart,
} from './staging-ownership';

type Candidate = {
  job: SaveJob;
  payload: string;
  owned: PartOwnership;
  fingerprint: PartFingerprint;
  missing: boolean;
  bytes: number;
};

const local = (job: SaveJob) =>
  job.usage === 'reference' && job.resultKey.startsWith('reference:');

/** Explicit cleanup of proven, incomplete local intake. Complete results are never candidates. */
export class StagingCleanupService {
  private previewed: {
    token: string;
    expires: number;
    files: Candidate[];
  } | null = null;
  private readonly running = new Set<{
    controller: AbortController;
    promise: Promise<unknown>;
  }>();
  private closed = false;

  constructor(
    private readonly staging: Staging,
    private readonly store: AppStore,
    private readonly notify: () => void,
  ) {}

  inspect(): Promise<StagingInspection> {
    return this.run(async (signal) => {
      this.staging.ownership.list();
      const items: StagingItem[] = [];
      for (const job of this.store
        .jobs()
        .filter((item) => item.status === 'failed'))
        items.push((await this.describe(job, signal)).item);
      return { items };
    });
  }

  preview(): Promise<StagingCleanupPreview> {
    this.previewed = null;
    return this.run(async (signal) => {
      this.staging.ownership.list();
      const files: Candidate[] = [];
      const retained: StagingItem[] = [];
      for (const job of this.store
        .jobs()
        .filter((item) => item.status === 'failed')) {
        const described = await this.describe(job, signal);
        if (described.candidate) files.push(described.candidate);
        else retained.push(described.item);
      }
      signal.throwIfAborted();
      const expires = Date.now() + 120_000;
      const token = files.length ? randomUUID() : null;
      this.previewed = token ? { token, expires, files } : null;
      return {
        token,
        expiresAt: token ? new Date(expires).toISOString() : null,
        files: files.map(({ job, bytes }) => ({
          jobId: job.id,
          name: job.name,
          bytes,
        })),
        bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        retained,
      };
    });
  }

  execute(token: string): Promise<StagingCleanupResult> {
    const preview = this.previewed;
    this.previewed = null;
    if (!preview || preview.token !== token || preview.expires <= Date.now())
      return Promise.reject(new Error('清理预览已失效，请重新检查'));
    return this.run(async (signal) => {
      if (preview.expires <= Date.now())
        throw new Error('清理预览已失效，请重新检查');
      // Validate the entire fixed selection before touching any file. A new
      // eligible job cannot expand an earlier user confirmation.
      for (const expected of preview.files) {
        signal.throwIfAborted();
        const current = await this.candidate(
          this.store.job(expected.job.id),
          signal,
        );
        if (
          current.payload !== expected.payload ||
          JSON.stringify(current.owned) !== JSON.stringify(expected.owned) ||
          current.missing !== expected.missing ||
          !samePart(current.fingerprint, expected.fingerprint)
        )
          throw new Error(
            '待清理文件或任务已变化，请重新预览；尚未清理任何文件',
          );
      }
      signal.throwIfAborted();
      const result: StagingCleanupResult = {
        removedCount: 0,
        removedBytes: 0,
        retained: [],
      };
      for (const file of preview.files) {
        try {
          signal.throwIfAborted();
          await this.remove(file, signal, () => {
            result.removedCount++;
            result.removedBytes += file.bytes;
          });
        } catch (error) {
          result.retained.push({
            jobId: file.job.id,
            name: file.job.name,
            reason: errorMessage(error),
          });
        }
      }
      this.notify();
      return result;
    });
  }

  cancel(): void {
    this.previewed = null;
    for (const operation of this.running)
      operation.controller.abort(
        new DOMException('暂存检查或清理已取消', 'AbortError'),
      );
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancel();
    await Promise.allSettled(
      [...this.running].map((operation) => operation.promise),
    );
  }

  async recover(): Promise<void> {
    // Only finish metadata for an already-confirmed unlink. A still-present
    // file requires a fresh explicit preview, even when an old intent exists.
    await this.run(async (signal) => {
      for (const owned of this.staging.ownership.list()) {
        signal.throwIfAborted();
        if (!owned.cleanup) continue;
        try {
          await this.staging.ownership.verifyDirectory(owned);
          if (
            (await this.info(this.part(owned.jobId))) ||
            (await this.info(this.staging.path(owned.jobId)))
          )
            continue;
          const job = this.store.jobs().find((item) => item.id === owned.jobId);
          if (
            job &&
            (JSON.stringify(job) !== owned.cleanup.job ||
              job.status !== 'failed' ||
              !local(job) ||
              job.sha256)
          )
            continue;
          await syncDirectory(this.staging.directory);
          signal.throwIfAborted();
          await this.staging.ownership.verifyDirectory(owned);
          if (
            (await this.info(this.part(owned.jobId))) ||
            (await this.info(this.staging.path(owned.jobId)))
          )
            continue;
          if (job) this.store.deleteJob(job.id, owned.cleanup.job);
          this.staging.ownership.forget(owned);
        } catch (error) {
          console.warn('保留尚未确认的暂存清理记录:', errorMessage(error));
        }
      }
    }).catch((error) => {
      // Corrupt ownership disables cleanup, not access to unrelated projects.
      // inspect/preview repeat validation and expose the exact failure to UI.
      console.warn('暂存清理恢复已保留原文件:', errorMessage(error));
    });
  }

  private async describe(
    job: SaveJob,
    signal: AbortSignal,
  ): Promise<{ item: StagingItem; candidate?: Candidate }> {
    signal.throwIfAborted();
    const item: StagingItem = {
      jobId: job.id,
      name: job.name,
      category: 'retained-result',
      cancelled: job.error === STAGING_CANCELLED,
      bytes: null,
      canRetry: false,
      canCleanup: false,
      reason: '',
    };
    try {
      const directory = await this.staging.ownership.directoryIdentity();
      const ready = await this.info(this.staging.path(job.id));
      if (job.sha256 || ready) {
        item.category = 'save-failed';
        if (
          ready?.isFile() &&
          !ready.isSymbolicLink() &&
          job.sha256 &&
          job.size > 0
        ) {
          const content = await fingerprint(this.staging.path(job.id), signal);
          const finalDirectory =
            await this.staging.ownership.directoryIdentity();
          const current = await this.info(this.staging.path(job.id));
          item.canRetry =
            sameContent(content, job) &&
            sameIdentity(directory, finalDirectory) &&
            !!current &&
            current.isFile() &&
            !current.isSymbolicLink() &&
            samePart(partFingerprint(ready), partFingerprint(current)) &&
            JSON.stringify(this.store.job(job.id)) === JSON.stringify(job);
          item.bytes = Number(ready.size);
        }
        item.reason = item.canRetry
          ? '完整结果已保留，可重试保存'
          : '完整或可恢复结果已保留；当前文件未通过完整校验';
      } else if (!local(job)) {
        item.reason = '云端或其他结果不属于本地未完成导入，不会清理';
      } else {
        item.category = 'incomplete-local';
        const candidate = await this.candidate(job, signal);
        item.bytes = candidate.bytes;
        item.canCleanup = true;
        item.reason = candidate.missing
          ? '已确认的文件移除待完成任务收尾'
          : '可清理本应用创建的未完成本地导入；原文件不变';
        return { item, candidate };
      }
    } catch (error) {
      signal.throwIfAborted();
      item.reason = errorMessage(error);
    }
    signal.throwIfAborted();
    return { item };
  }

  private async candidate(
    job: SaveJob,
    signal: AbortSignal,
    verifyContent = true,
  ): Promise<Candidate> {
    signal.throwIfAborted();
    if (job.status !== 'failed' || !local(job) || job.sha256)
      throw new Error('任务已不是可清理的未完成本地导入');
    const owned = this.staging.ownership.get(job.id);
    if (!owned) throw new Error('缺少创建时的文件归属证据；旧暂存文件已保留');
    if (!owned.sealedFingerprint || !owned.partialSha256)
      throw new Error('接收中断前未确认文件状态，原暂存文件已保留');
    await this.staging.ownership.verifyDirectory(owned);
    if (await this.info(this.staging.path(job.id)))
      throw new Error('完整暂存结果存在，不能清理');
    const info = await this.info(this.part(job.id));
    const payload = JSON.stringify(job);
    if (!info) {
      if (!owned.cleanup || owned.cleanup.job !== payload)
        throw new Error('暂存文件缺失，但没有已确认的清理记录；任务已保留');
      return {
        job,
        payload,
        owned,
        fingerprint: owned.cleanup.fingerprint,
        missing: true,
        bytes: 0,
      };
    }
    const statFingerprint = partFingerprint(info);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !sameIdentity(statFingerprint, owned.fileIdentity)
    )
      throw new Error('暂存文件与创建记录不匹配，原文件已保留');
    if (!samePart(statFingerprint, owned.sealedFingerprint))
      throw new Error('暂存文件在接收结束后已变化，原文件已保留');
    const bytes = Number(info.size);
    if (!Number.isSafeInteger(bytes))
      throw new Error('文件大小无法安全表示，已保留');
    if (verifyContent) {
      const content = await fingerprint(this.part(job.id), signal);
      await this.staging.ownership.verifyDirectory(owned);
      const after = await this.info(this.part(job.id));
      if (
        content.sha256 !== owned.partialSha256 ||
        content.size !== bytes ||
        !after ||
        !samePart(statFingerprint, partFingerprint(after))
      )
        throw new Error('暂存内容与实际接收的字节不符，原文件已保留');
    }
    signal.throwIfAborted();
    return {
      job,
      payload,
      owned,
      fingerprint: statFingerprint,
      missing: false,
      bytes,
    };
  }

  private async remove(
    file: Candidate,
    signal: AbortSignal,
    removed: () => void,
  ): Promise<void> {
    const owned = this.staging.ownership.markCleanup(
      file.owned,
      file.payload,
      file.fingerprint,
    );
    const current = await this.candidate(
      this.store.job(file.job.id),
      signal,
      false,
    );
    if (
      current.payload !== file.payload ||
      current.missing !== file.missing ||
      !samePart(current.fingerprint, file.fingerprint)
    )
      throw new Error('确认后文件或任务已变化，已保留');
    await this.staging.ownership.verifyDirectory(owned);
    if (await this.info(this.staging.path(file.job.id)))
      throw new Error('完整暂存结果已出现，原文件已保留');
    const last = await this.info(this.part(file.job.id));
    if (
      file.missing
        ? last !== null
        : !last?.isFile() ||
          last.isSymbolicLink() ||
          !samePart(partFingerprint(last), file.fingerprint)
    )
      throw new Error('移除前暂存文件已变化，原文件已保留');
    if (
      JSON.stringify(this.store.job(file.job.id)) !== file.payload ||
      JSON.stringify(this.staging.ownership.get(file.job.id)) !==
        JSON.stringify(owned)
    )
      throw new Error('移除前暂存任务已变化，原文件已保留');
    signal.throwIfAborted();
    if (!file.missing) {
      await unlink(this.part(file.job.id));
      removed();
    }
    // Once unlink has succeeded, finish its durable bookkeeping despite a late
    // cancel. Any error leaves the confirmation journal available for recovery.
    await syncDirectory(this.staging.directory);
    this.store.deleteJob(file.job.id, file.payload);
    this.staging.ownership.forget(owned);
  }

  private part(id: string) {
    return join(this.staging.directory, `${id}.part`);
  }
  private async info(file: string) {
    return lstat(file, { bigint: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      },
    );
  }

  private run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('应用正在关闭'));
    const controller = new AbortController();
    let started = false;
    let rejectQueued!: (reason: unknown) => void;
    const cancelled = new Promise<T>((_resolve, reject) => {
      rejectQueued = reject;
    });
    const abort = () => {
      if (!started) rejectQueued(controller.signal.reason);
    };
    controller.signal.addEventListener('abort', abort, { once: true });
    const work = this.staging.exclusive(async () => {
      controller.signal.throwIfAborted();
      started = true;
      return operation(controller.signal);
    });
    const promise = Promise.race([work, cancelled]).finally(() => {
      controller.signal.removeEventListener('abort', abort);
      this.running.delete(record);
    });
    const record = { controller, promise };
    this.running.add(record);
    return promise;
  }
}
