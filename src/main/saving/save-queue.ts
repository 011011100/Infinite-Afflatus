import { lstat, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Asset, SaveJob } from '../../shared/models';
import { recordAsset } from '../projects/project-database';
import type { ProjectService } from '../projects/project-service';
import type { AppStore } from '../storage/app-store';
import { errorMessage } from '../storage/database';
import {
  fingerprint,
  inside,
  publishCopy,
  safeFile,
  sameContent,
} from '../storage/files';
import type { WriteGate } from '../storage/write-gate';
import type { Staging } from './staging';

export class SaveQueue {
  private running: Promise<void> | null = null;
  private enabled = false;
  constructor(
    private readonly store: AppStore,
    private readonly projects: ProjectService,
    private readonly gate: WriteGate,
    private readonly staging: Staging,
    private readonly notify: () => void,
  ) {}

  kick(): void {
    if (!this.enabled || this.running || this.gate.isBlocked) return;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
  }

  start(): void {
    this.enabled = true;
    this.kick();
  }

  private async drain(): Promise<void> {
    while (!this.gate.isBlocked) {
      const job = this.store
        .jobs()
        .reverse()
        .find((item) => item.status === 'ready');
      if (!job) return;
      try {
        await this.gate.run(() => this.commit(job));
      } catch (error) {
        job.status = 'failed';
        job.error = errorMessage(error);
        this.store.putJob(job);
        this.notify();
      }
    }
  }

  private async commit(job: SaveJob): Promise<void> {
    job.status = 'saving';
    job.error = null;
    this.store.putJob(job);
    this.notify();
    // Resolve the root only after admission to the shared gate.
    const snapshot = await this.projects.open(job.projectId);
    const database = await this.projects.databasePath(job.projectId);
    const projectRoot = dirname(database);
    const existingAsset = snapshot.assets.find((asset) => asset.id === job.id);
    const category = {
      video: 'videos',
      image: 'images',
      audio: 'audio',
      text: 'text',
    }[job.kind];
    let relativePath =
      existingAsset?.relativePath ??
      job.outputRelativePath ??
      `assets/${category}/${job.id}.${job.extension}`;
    let destination = inside(projectRoot, relativePath);
    if (
      existingAsset &&
      (existingAsset.sha256 !== job.sha256 ||
        existingAsset.relativePath !== relativePath)
    ) {
      throw new Error('已有素材与保存任务不匹配');
    }
    let destinationExists = false;
    try {
      await lstat(destination);
      destinationExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (destinationExists && !existingAsset) {
      let matches = false;
      try {
        matches = sameContent(
          await fingerprint(await safeFile(projectRoot, relativePath)),
          job,
        );
      } catch {
        /* An interrupted or user-replaced unregistered copy must be preserved. */
      }
      if (!matches) {
        relativePath = `assets/${category}/${job.id}-${randomUUID()}.${job.extension}`;
        destination = inside(projectRoot, relativePath);
        destinationExists = false;
      }
    }
    job.outputRelativePath = relativePath;
    this.store.putJob(job);
    if (!destinationExists) {
      if (!sameContent(await fingerprint(this.staging.path(job.id)), job))
        throw new Error('暂存结果校验失败');
      // These directories are created with the project; verify parents before writing.
      for (const part of ['assets', `assets/${category}`]) {
        const directory = inside(projectRoot, part);
        await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
        const info = await lstat(directory);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error('素材目录不能是符号链接或文件');
      }
      await publishCopy(this.staging.path(job.id), destination);
    }
    if (
      !sameContent(
        await fingerprint(await safeFile(projectRoot, relativePath)),
        job,
      )
    ) {
      throw new Error('目标文件校验失败，暂存结果已保留');
    }
    const asset: Asset = {
      id: job.id,
      name: job.name,
      relativePath,
      size: job.size,
      sha256: job.sha256,
      kind: job.kind,
      ...(job.usage ? { usage: job.usage } : {}),
    };
    this.store.putProject(
      recordAsset(
        database,
        job.resultKey,
        asset,
        this.projects.summary(job.projectId),
      ),
    );
    job.status = 'saved';
    this.store.putJob(job);
    this.notify();
    await this.staging.remove(job).catch(() => {
      /* Startup retries cache cleanup after the durable acknowledgement. */
    });
  }

  async retry(id: string): Promise<void> {
    const job = this.store.job(id);
    if (job.status !== 'failed') return;
    if (
      !job.sha256 ||
      !sameContent(await fingerprint(this.staging.path(job.id)), job)
    ) {
      throw new Error(
        '结果尚未完整下载，请重新导入原文件；云端结果需要重新下载',
      );
    }
    job.status = 'ready';
    job.error = null;
    this.store.putJob(job);
    this.notify();
    this.kick();
  }

  async idle(): Promise<void> {
    await this.running;
  }
}

import { randomUUID } from 'node:crypto';
