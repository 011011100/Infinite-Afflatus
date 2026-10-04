import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { SaveJob } from '../../shared/models';
import type { AppStore } from '../storage/app-store';
import { errorMessage } from '../storage/database';
import {
  checkSpace,
  fingerprint,
  sameContent,
  syncDirectory,
} from '../storage/files';
import {
  identity,
  type PartOwnership,
  StagingOwnership,
  sameIdentity,
} from './staging-ownership';

export interface GeneratedResult {
  projectId: string;
  resultKey: string;
  name: string;
  kind: SaveJob['kind'];
  usage?: SaveJob['usage'];
  extension: string;
}

export interface StagingProgress {
  phase: 'receiving' | 'finalizing';
  bytes: number;
}

export interface StagingReceiveControls {
  signal?: AbortSignal;
  onProgress?: (progress: StagingProgress) => void;
}

export const STAGING_CANCELLED = '接收结果已取消';

/** Every result goes to durable userData staging, including results received outside migration. */
export class Staging {
  private receiving: Promise<unknown> = Promise.resolve();
  readonly ownership: StagingOwnership;
  constructor(
    readonly directory: string,
    private readonly store: AppStore,
    private readonly notify: () => void,
    private readonly quota = 20 * 1024 ** 3,
  ) {
    this.ownership = new StagingOwnership(directory, store);
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.receiving.then(operation);
    this.receiving = work.catch(() => undefined);
    return work;
  }

  path(id: string): string {
    return join(this.directory, `${id}.ready`);
  }

  receive(
    result: GeneratedResult,
    stream: Readable,
    controls: StagingReceiveControls = {},
  ): Promise<SaveJob> {
    // A remote response can fail while waiting its turn; iteration will surface the error.
    stream.on('error', () => undefined);
    // One ingestion at a time makes the disk quota exact; cloud tasks themselves remain independent.
    let started = false;
    let cancelQueued: ((reason: unknown) => void) | undefined;
    const cancelled = new Promise<SaveJob>((_resolve, reject) => {
      cancelQueued = reject;
    });
    const abort = () => {
      const reason = controls.signal?.reason;
      stream.destroy(
        reason instanceof Error
          ? reason
          : new DOMException(STAGING_CANCELLED, 'AbortError'),
      );
      if (!started) cancelQueued?.(controls.signal?.reason);
    };
    const work = this.exclusive(() => {
      controls.signal?.throwIfAborted();
      started = true;
      return this.write(result, stream, controls);
    });
    const cleanup = () => controls.signal?.removeEventListener('abort', abort);
    void work.then(cleanup, cleanup);
    controls.signal?.addEventListener('abort', abort, { once: true });
    if (controls.signal?.aborted) abort();
    // Queued cancellation is observable now; its later turn still checks the
    // signal before creating a job or touching staging files.
    return controls.signal ? Promise.race([work, cancelled]) : work;
  }

  private async write(
    result: GeneratedResult,
    stream: Readable,
    controls: StagingReceiveControls,
  ): Promise<SaveJob> {
    const { signal, onProgress } = controls;
    const progress = (phase: StagingProgress['phase'], bytes: number) => {
      try {
        onProgress?.({ phase, bytes });
      } catch {
        // A progress observer cannot change whether bytes are durably accepted.
      }
    };
    signal?.throwIfAborted();
    const previous = this.store
      .jobs()
      .find(
        (job) =>
          job.projectId === result.projectId &&
          job.resultKey === result.resultKey,
      );
    if (previous) {
      stream.destroy();
      return previous;
    }
    if (
      !/^[a-z0-9]{1,10}$/.test(result.extension) ||
      !result.resultKey ||
      result.resultKey.length > 300
    ) {
      stream.destroy();
      throw new Error('无效的生成结果');
    }
    if (
      !this.store.projects().some((project) => project.id === result.projectId)
    ) {
      stream.destroy();
      throw new Error('结果所属项目不存在');
    }
    await mkdir(this.directory, { recursive: true });
    const directoryIdentity = await this.ownership.directoryIdentity();
    const job: SaveJob = {
      ...result,
      id: randomUUID(),
      status: 'receiving',
      size: 0,
      sha256: '',
      error: null,
      createdAt: new Date().toISOString(),
    };
    let pendingBytes = 0;
    for (const entry of await readdir(this.directory)) {
      signal?.throwIfAborted();
      const info = await lstat(join(this.directory, entry)).catch(() => null);
      if (info?.isFile()) pendingBytes += info.size;
    }
    const partial = join(this.directory, `${job.id}.part`);
    signal?.throwIfAborted();
    this.store.putJob(job);
    this.notify();
    try {
      progress('receiving', 0);
      signal?.throwIfAborted();
      const handle = await open(
        partial,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      const hash = createHash('sha256');
      try {
        if (job.usage === 'reference' && job.resultKey.startsWith('reference:'))
          await this.ownership.registerCreated(
            job.id,
            handle,
            directoryIdentity,
          );
        for await (const chunk of stream) {
          signal?.throwIfAborted();
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (pendingBytes + job.size + bytes.length > this.quota)
            throw new Error('结果暂存空间已达上限，请先完成保存或释放磁盘空间');
          await checkSpace(this.directory, bytes.length);
          let offset = 0;
          while (offset < bytes.length) {
            signal?.throwIfAborted();
            const { bytesWritten } = await handle.write(
              bytes,
              offset,
              bytes.length - offset,
            );
            if (!bytesWritten) throw new Error('暂存文件写入中断');
            hash.update(bytes.subarray(offset, offset + bytesWritten));
            offset += bytesWritten;
            job.size += bytesWritten;
            progress('receiving', job.size);
          }
        }
        signal?.throwIfAborted();
        if (!job.size) throw new Error('生成结果为空');
        progress('finalizing', job.size);
        signal?.throwIfAborted();
        await handle.sync();
      } catch (error) {
        if (
          job.usage === 'reference' &&
          job.resultKey.startsWith('reference:')
        ) {
          try {
            await this.ownership.sealIncomplete(
              job.id,
              handle,
              job.size,
              hash.copy().digest('hex'),
            );
          } catch (sealError) {
            console.warn(
              '未完成暂存已保留，不能自动认领清理:',
              errorMessage(sealError),
            );
          }
        }
        throw error;
      } finally {
        await handle.close();
      }
      signal?.throwIfAborted();
      job.sha256 = hash.digest('hex');
      // Persist the expected digest before rename so startup can recognize a complete result.
      this.store.putJob(job);
      signal?.throwIfAborted();
      await rename(partial, this.path(job.id));
      // Publication has started: finish durable acknowledgement even if a late
      // cancellation arrives, so a completed result keeps its stable ID.
      await syncDirectory(this.directory);
      job.status = 'ready';
      if (job.usage === 'reference' && job.resultKey.startsWith('reference:')) {
        this.forgetPublishedOwnership(job.id);
      }
    } catch (error) {
      stream.destroy();
      job.status = 'failed';
      job.error =
        signal?.aborted &&
        (error === signal.reason ||
          (error instanceof Error && error.name === 'AbortError'))
          ? STAGING_CANCELLED
          : `接收结果失败：${errorMessage(error)}`;
      // Incomplete bytes are never mistaken for a generated result. Keep them for diagnosis.
    }
    this.store.putJob(job);
    this.notify();
    return job;
  }

  async recover(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    for (const job of this.store.jobs()) {
      if (job.status === 'saved') {
        await this.remove(job).catch(() => undefined);
      } else if (job.status === 'receiving') {
        try {
          if (!job.sha256) throw new Error('下载未完成');
          const owned =
            job.usage === 'reference' && job.resultKey.startsWith('reference:')
              ? this.ownership.get(job.id)
              : null;
          const ready = await lstat(this.path(job.id)).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
              return null;
            },
          );
          if (!ready) {
            const partial = join(this.directory, `${job.id}.part`);
            if (owned) await this.verifyOwnedFile(owned, partial);
            if (!sameContent(await fingerprint(partial), job))
              throw new Error('暂存文件不完整');
            if (owned) {
              await this.verifyOwnedFile(owned, partial);
              // Exclusive publication cannot replace a file that appeared
              // after the missing-ready check. Keep either link on a fault.
              await link(partial, this.path(job.id));
              await this.verifyOwnedFile(owned, partial);
              await unlink(partial);
              await syncDirectory(this.directory);
            } else await rename(partial, this.path(job.id));
          }
          if (owned) await this.verifyOwnedFile(owned, this.path(job.id));
          if (!sameContent(await fingerprint(this.path(job.id)), job))
            throw new Error('暂存文件校验失败');
          if (owned) this.forgetPublishedOwnership(job.id);
          job.status = 'ready';
          job.error = null;
        } catch {
          job.status = 'failed';
          job.error =
            '上次接收被中断，需要从原生成结果重新下载；不会重新发起生成';
        }
        this.store.putJob(job);
      } else if (job.status === 'saving') {
        job.status = 'ready';
        this.store.putJob(job);
      }
    }
  }

  private async verifyOwnedFile(
    owned: PartOwnership,
    file: string,
  ): Promise<void> {
    await this.ownership.verifyDirectory(owned);
    const info = await lstat(file, { bigint: true });
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      !sameIdentity(identity(info), owned.fileIdentity)
    )
      throw new Error('暂存文件与创建记录不匹配，原文件已保留');
  }

  private forgetPublishedOwnership(id: string): void {
    try {
      const owned = this.ownership.get(id);
      if (owned) this.ownership.forget(owned);
    } catch (error) {
      // Complete publication remains accepted even if optional cleanup metadata
      // cannot be compacted. The ready file excludes it from partial cleanup.
      console.warn('完整结果已保留，暂存归属记录待收尾:', errorMessage(error));
    }
  }

  async remove(job: SaveJob, signal?: AbortSignal): Promise<void> {
    // A changed cache file might be user data; do not delete it blindly.
    const file = this.path(job.id);
    const verified = await fingerprint(file, signal);
    if (!sameContent(verified, job)) throw new Error('暂存文件已变化，已保留');
    const current = await lstat(file);
    if (
      current.isSymbolicLink() ||
      current.dev !== verified.device ||
      current.ino !== verified.inode ||
      current.size !== verified.size ||
      current.mtimeMs !== verified.modified
    )
      throw new Error('暂存文件已变化，已保留');
    signal?.throwIfAborted();
    await unlink(file);
  }

  async idle(): Promise<void> {
    await this.receiving;
  }
}
