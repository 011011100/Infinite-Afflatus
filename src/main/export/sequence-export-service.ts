import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { CanvasCard } from '../../shared/canvas/model';
import { clipRange } from '../../shared/canvas/trim';
import {
  exportIsActive,
  type SequenceExportJob,
  type SequenceExportOptions,
  validateExportOptions,
} from '../../shared/export';
import type { Asset } from '../../shared/models';
import type { ProjectService } from '../projects/project-service';
import type { AppStore } from '../storage/app-store';
import { errorMessage } from '../storage/database';
import {
  checkSpace,
  fingerprint,
  localFileStream,
  safeFile,
  sameContent,
} from '../storage/files';
import type { WriteGate } from '../storage/write-gate';
import { type ExportClip, encodeSequence } from './encode-sequence';
import { ExportWork } from './export-work';
import { exportDimensions, probeExportMedia } from './media-probe';
import {
  cleanPendingOutput,
  publishOutput,
  validateOutputPath,
} from './publish-output';

interface ExportSnapshot {
  card: CanvasCard;
  assets: Asset[];
}

/** Saved sequence snapshot -> independent inputs -> encoded MP4 -> exclusive publication. */
export class SequenceExportService {
  private work: ExportWork;
  private task: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private preparation: AbortController | null = null;
  private cancellationEpoch = 0;
  private starting = false;
  private startingDone: Promise<void> | null = null;
  private closed = false;
  private lastProgress = 0;

  constructor(
    private projects: ProjectService,
    private gate: WriteGate,
    private store: AppStore,
    private userData: string,
    private changed: () => void = () => {},
    private media = { probe: probeExportMedia, encode: encodeSequence },
  ) {
    this.work = new ExportWork(store, join(userData, 'export-work'));
  }

  /** Native file selections opened before a leave request cannot start later. */
  get cancellationVersion(): number {
    return this.cancellationEpoch;
  }

  async cancelPreparation(): Promise<void> {
    this.cancellationEpoch += 1;
    const controller = this.preparation;
    if (!controller) return;
    // Capture only this attempt. Encoding/finalizing has already released the
    // write gate and must continue when macOS merely closes its window.
    const starting = this.startingDone;
    const task = this.task;
    controller.abort();
    await starting;
    // A synchronous job notification may cancel just before start assigns task.
    // Join that same controller's cleanup, never a later export attempt.
    await (task ?? (this.abort === controller ? this.task : null));
  }

  private releaseController(controller: AbortController): void {
    if (this.abort === controller) this.abort = null;
    if (this.preparation === controller) this.preparation = null;
  }

  list(): SequenceExportJob[] {
    return this.store.get<SequenceExportJob[]>('sequenceExports') ?? [];
  }

  get(id: string): SequenceExportJob {
    const job = this.list().find((item) => item.id === id);
    if (!job) throw new Error('导出任务不存在');
    return job;
  }

  private update(
    job: SequenceExportJob,
    changes: Partial<SequenceExportJob> = {},
  ): void {
    Object.assign(job, changes);
    this.store.set(
      'sequenceExports',
      [job, ...this.list().filter((item) => item.id !== job.id)].slice(0, 20),
    );
    this.changed();
  }

  async recover(): Promise<void> {
    await this.work.clean();
    await cleanPendingOutput(this.store);
    for (const job of this.list()) {
      if (exportIsActive(job))
        this.update(job, {
          status: 'failed',
          error: '上次导出因应用中断而停止，请重新导出；源项目未改变',
          finishedAt: new Date().toISOString(),
        });
    }
  }

  async start(
    projectId: string,
    cardId: string,
    outputPath: string,
    input?: SequenceExportOptions,
  ): Promise<SequenceExportJob> {
    if (this.closed) throw new Error('应用正在关闭');
    if (this.starting || this.task)
      throw new Error('已有视频正在导出，请完成或取消后重试');
    this.starting = true;
    const controller = new AbortController();
    const signal = controller.signal;
    this.abort = controller;
    this.preparation = controller;
    let finishStarting!: () => void;
    this.startingDone = new Promise<void>((resolve) => {
      finishStarting = resolve;
    });
    try {
      const options = validateExportOptions(input);
      const output = await validateOutputPath(
        outputPath,
        this.store.root,
        this.userData,
      );
      signal.throwIfAborted();
      const { project, snapshot } = await this.gate.run(async () => {
        signal.throwIfAborted();
        const current = await this.projects.open(projectId);
        signal.throwIfAborted();
        const card = current.canvas.cards.find((item) => item.id === cardId);
        if (!card) throw new Error('要导出的视频组合不存在，请重新打开');
        const assets = card.assetIds.map((id) => {
          const asset = current.assets.find(
            (item) => item.id === id && item.kind === 'video',
          );
          if (!asset) throw new Error('组合包含不可用的视频');
          return asset;
        });
        if (!assets.length) throw new Error('组合中没有可导出的视频');
        return { project: current.project, snapshot: { card, assets } };
      });
      signal.throwIfAborted();
      if (this.closed) throw new Error('应用正在关闭');
      const job: SequenceExportJob = {
        id: randomUUID(),
        projectId,
        cardId,
        projectName: project.name,
        outputPath: output,
        status: 'preparing',
        progress: 0,
        error: null,
        createdAt: new Date().toISOString(),
        finishedAt: null,
        clipCount: snapshot.assets.length,
        duration: 0,
        options,
      };
      this.lastProgress = 0;
      this.update(job);
      this.task = this.run(job, snapshot, signal).finally(() => {
        this.task = null;
        this.releaseController(controller);
      });
      return { ...job };
    } finally {
      this.starting = false;
      if (!this.task) this.releaseController(controller);
      finishStarting();
      this.startingDone = null;
    }
  }

  cancel(id: string): void {
    if (exportIsActive(this.get(id))) this.abort?.abort();
  }

  private progress(
    job: SequenceExportJob,
    value: number,
    status = job.status,
  ): void {
    const progress = Math.max(job.progress, Math.min(0.99, value));
    const now = Date.now();
    if (status === job.status && now - this.lastProgress < 200) return;
    this.lastProgress = now;
    this.update(job, { progress, status });
  }

  private async copyInputs(
    job: SequenceExportJob,
    snapshot: ExportSnapshot,
    signal: AbortSignal,
  ): Promise<string[]> {
    return this.gate.whenOpen(async () => {
      signal.throwIfAborted();
      const root = dirname(await this.projects.databasePath(job.projectId));
      const bytes = snapshot.assets.reduce((sum, asset) => sum + asset.size, 0);
      // Encoding needs additional space, checked after media durations are known.
      await checkSpace(this.userData, bytes);
      const files: string[] = [];
      let copied = 0;
      for (const asset of snapshot.assets) {
        signal.throwIfAborted();
        const output = await this.work.create('source');
        await pipeline(
          await localFileStream(await safeFile(root, asset.relativePath)),
          createWriteStream(output, { flags: 'r+' }),
          { signal },
        );
        if (!sameContent(await fingerprint(output, signal), asset))
          throw new Error(`素材内容已变化：${asset.name}`);
        files.push(output);
        copied += asset.size;
        this.progress(job, bytes ? (0.1 * copied) / bytes : 0);
      }
      return files;
    }, signal);
  }

  private async run(
    job: SequenceExportJob,
    snapshot: ExportSnapshot,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const files = await this.copyInputs(job, snapshot, signal);
      signal.throwIfAborted();
      const clips: ExportClip[] = [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const asset = snapshot.assets[index];
        if (!file || !asset) throw new Error('导出素材准备失败');
        signal.throwIfAborted();
        const media = await this.media.probe(file, signal);
        const range = clipRange(
          media.duration,
          snapshot.card.trims?.[asset.id],
        );
        clips.push({ file, media, range });
      }
      const first = clips[0];
      if (!first) throw new Error('没有可导出的视频');
      const duration = clips.reduce(
        (sum, clip) => sum + clip.range.end - clip.range.start,
        0,
      );
      // Approximate reserve for normalized video, PCM intermediates and the final MP4.
      await checkSpace(this.userData, Math.ceil(duration * 5_000_000));
      signal.throwIfAborted();
      // Phase transition and cancellation boundary are synchronous.
      this.preparation = null;
      this.update(job, { duration, status: 'encoding', progress: 0.1 });
      const output = await this.media.encode(
        clips,
        exportDimensions(first.media, job.options),
        job.options,
        this.work,
        signal,
        (fraction, finalizing) =>
          this.progress(
            job,
            0.1 + fraction * 0.85,
            finalizing ? 'finalizing' : 'encoding',
          ),
      );
      const result = await this.media.probe(output, signal);
      const tolerance = Math.max(
        0.12,
        clips.length / job.options.frameRate + 0.05,
      );
      if (Math.abs(result.duration - duration) > tolerance || !result.hasAudio)
        throw new Error('导出结果时长或音轨校验未通过');
      this.update(job, { status: 'finalizing', progress: 0.97 });
      // Recheck after encoding: another program may have created the chosen filename.
      await validateOutputPath(job.outputPath, this.store.root, this.userData);
      await publishOutput(output, job.outputPath, this.store, signal);
      this.update(job, {
        status: 'completed',
        progress: 1,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.update(job, {
        status: signal.aborted ? 'cancelled' : 'failed',
        error: signal.aborted ? null : errorMessage(error),
        finishedAt: new Date().toISOString(),
      });
    } finally {
      await this.work.clean();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancellationEpoch += 1;
    this.abort?.abort();
    await this.startingDone;
    await this.task;
  }
}
