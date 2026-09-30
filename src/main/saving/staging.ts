import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
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

export interface GeneratedResult {
  projectId: string;
  resultKey: string;
  name: string;
  kind: SaveJob['kind'];
  usage?: SaveJob['usage'];
  extension: string;
}

/** Every result goes to durable userData staging, including results received outside migration. */
export class Staging {
  private receiving: Promise<unknown> = Promise.resolve();
  constructor(
    readonly directory: string,
    private readonly store: AppStore,
    private readonly notify: () => void,
    private readonly quota = 20 * 1024 ** 3,
  ) {}

  path(id: string): string {
    return join(this.directory, `${id}.ready`);
  }

  receive(result: GeneratedResult, stream: Readable): Promise<SaveJob> {
    // A remote response can fail while waiting its turn; iteration will surface the error.
    stream.on('error', () => undefined);
    // One ingestion at a time makes the disk quota exact; cloud tasks themselves remain independent.
    const work = this.receiving.then(() => this.write(result, stream));
    this.receiving = work.catch(() => undefined);
    return work;
  }

  private async write(
    result: GeneratedResult,
    stream: Readable,
  ): Promise<SaveJob> {
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
      const info = await lstat(join(this.directory, entry)).catch(() => null);
      if (info?.isFile()) pendingBytes += info.size;
    }
    const partial = join(this.directory, `${job.id}.part`);
    this.store.putJob(job);
    this.notify();
    try {
      const handle = await open(
        partial,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      const hash = createHash('sha256');
      try {
        for await (const chunk of stream) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (pendingBytes + job.size + bytes.length > this.quota)
            throw new Error('结果暂存空间已达上限，请先完成保存或释放磁盘空间');
          await checkSpace(this.directory, bytes.length);
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await handle.write(
              bytes,
              offset,
              bytes.length - offset,
            );
            if (!bytesWritten) throw new Error('暂存文件写入中断');
            offset += bytesWritten;
          }
          hash.update(bytes);
          job.size += bytes.length;
        }
        if (!job.size) throw new Error('生成结果为空');
        await handle.sync();
      } finally {
        await handle.close();
      }
      job.sha256 = hash.digest('hex');
      // Persist the expected digest before rename so startup can recognize a complete result.
      this.store.putJob(job);
      await rename(partial, this.path(job.id));
      await syncDirectory(this.directory);
      job.status = 'ready';
    } catch (error) {
      stream.destroy();
      job.status = 'failed';
      job.error = `接收结果失败：${errorMessage(error)}`;
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
          try {
            await fingerprint(this.path(job.id));
          } catch {
            const partial = join(this.directory, `${job.id}.part`);
            if (!sameContent(await fingerprint(partial), job))
              throw new Error('暂存文件不完整');
            await rename(partial, this.path(job.id));
          }
          if (!sameContent(await fingerprint(this.path(job.id)), job))
            throw new Error('暂存文件校验失败');
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

  async remove(job: SaveJob): Promise<void> {
    // A changed cache file might be user data; do not delete it blindly.
    const file = this.path(job.id);
    if (!sameContent(await fingerprint(file), job))
      throw new Error('暂存文件已变化，已保留');
    await unlink(file);
  }

  async idle(): Promise<void> {
    await this.receiving;
  }
}
