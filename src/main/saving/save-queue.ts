import { randomUUID } from 'node:crypto';
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

export interface LocalReferencePause {
  idle(): Promise<void>;
  resume(): void;
}

function isLocalReference(job: SaveJob): boolean {
  return job.usage === 'reference' && job.resultKey.startsWith('reference:');
}

export class SaveQueue {
  private running: Promise<void> | null = null;
  private enabled = false;
  private readonly referencePauses = new Set<symbol>();
  private activeReference: {
    controller: AbortController;
    done: Promise<void>;
  } | null = null;
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
      // A pause can be released after drain's last lookup but before this
      // continuation. Do not strand the ready job in that small window.
      if (this.nextReady()) this.kick();
    });
  }

  start(): void {
    this.enabled = true;
    this.kick();
  }

  pauseLocalReferences(): LocalReferencePause {
    const token = Symbol('local-reference-pause');
    this.referencePauses.add(token);
    const active = this.activeReference;
    active?.controller.abort();
    return {
      idle: () => active?.done ?? Promise.resolve(),
      resume: () => {
        if (!this.referencePauses.delete(token)) return;
        if (!this.referencePauses.size) this.kick();
      },
    };
  }

  private nextReady(): SaveJob | undefined {
    return this.store
      .jobs()
      .reverse()
      .find(
        (item) =>
          item.status === 'ready' &&
          (!isLocalReference(item) || !this.referencePauses.size),
      );
  }

  private async drain(): Promise<void> {
    while (!this.gate.isBlocked) {
      const job = this.nextReady();
      if (!job) return;
      let finish = () => {};
      const active = isLocalReference(job)
        ? {
            controller: new AbortController(),
            done: new Promise<void>((resolve) => {
              finish = resolve;
            }),
          }
        : null;
      this.activeReference = active;
      try {
        await this.gate.run(() => this.commit(job, active?.controller.signal));
      } catch (error) {
        const signal = active?.controller.signal;
        const cancelled =
          signal?.aborted &&
          (error === signal.reason ||
            (error instanceof Error && error.name === 'AbortError'));
        job.status = cancelled ? 'ready' : 'failed';
        job.error = cancelled ? null : errorMessage(error);
        this.store.putJob(job);
        this.notify();
      } finally {
        if (this.activeReference === active) this.activeReference = null;
        finish();
      }
    }
  }

  private async commit(job: SaveJob, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    job.status = 'saving';
    job.error = null;
    this.store.putJob(job);
    this.notify();
    // Resolve the root only after admission to the shared gate.
    const snapshot = await this.projects.open(job.projectId);
    signal?.throwIfAborted();
    const database = await this.projects.databasePath(job.projectId);
    signal?.throwIfAborted();
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
          await fingerprint(await safeFile(projectRoot, relativePath), signal),
          job,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
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
    signal?.throwIfAborted();
    if (!destinationExists) {
      if (
        !sameContent(await fingerprint(this.staging.path(job.id), signal), job)
      )
        throw new Error('暂存结果校验失败');
      // These directories are created with the project; verify parents before writing.
      for (const part of ['assets', `assets/${category}`]) {
        signal?.throwIfAborted();
        const directory = inside(projectRoot, part);
        await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
        const info = await lstat(directory);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new Error('素材目录不能是符号链接或文件');
      }
      await publishCopy(this.staging.path(job.id), destination, signal);
    }
    if (
      !sameContent(
        await fingerprint(await safeFile(projectRoot, relativePath), signal),
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
    signal?.throwIfAborted();
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
    await this.staging.remove(job, signal).catch(() => {
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
    // Finishing a drain can start its successor. Await each actual run, while
    // paused ready jobs remain idle until their owner releases the pause.
    while (this.running) await this.running;
  }
}
