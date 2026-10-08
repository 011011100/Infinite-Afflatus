import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { referenceKind } from '../../shared/generation/reference-files';
import type { Asset, SaveJob } from '../../shared/models';
import { readProject } from '../projects/project-database';
import { isId, type ProjectService } from '../projects/project-service';
import { validateAsset } from '../recovery/asset-inspection';
import type { AppStore } from '../storage/app-store';
import { safeFile } from '../storage/files';
import {
  directoryIdentity,
  directoryIdentitySync,
  ordinaryFileState,
  ordinaryFileStateSync,
  sameFileIdentity,
  sameFileState,
} from './file-state';

/** The consumer owns this descriptor and must close it, including on cancellation. */
export interface OpenedProjectMedia {
  handle: FileHandle;
  /** Used only for the media type; never reopened by a consumer. */
  filename: string;
  source: 'committed' | 'staged';
}

const changed = () => new Error('素材或项目位置已变化，请重新读取');

function completeLocalReference(job: SaveJob): boolean {
  return (
    job.usage === 'reference' &&
    job.resultKey.startsWith('reference:') &&
    ['ready', 'saving', 'failed'].includes(job.status) &&
    Number.isSafeInteger(job.size) &&
    job.size > 0 &&
    /^[a-f0-9]{64}$/.test(job.sha256) &&
    /^[a-z0-9]{1,10}$/.test(job.extension) &&
    referenceKind(job.extension) === job.kind
  );
}

function sameReference(a: SaveJob, b: SaveJob): boolean {
  return (
    a.id === b.id &&
    a.projectId === b.projectId &&
    a.resultKey === b.resultKey &&
    a.kind === b.kind &&
    a.usage === b.usage &&
    a.extension === b.extension &&
    a.size === b.size &&
    a.sha256 === b.sha256
  );
}

/** Read authority for registered media and complete, still-unsaved local references. */
export class ProjectReferenceReader {
  constructor(
    private readonly projects: ProjectService,
    private readonly store: AppStore,
    private readonly stagingDirectory?: string,
  ) {}

  private async context(projectId: string) {
    const root = this.store.root;
    const project = this.projects.summary(projectId);
    const rootIdentity = await directoryIdentity(root);
    const database = await this.projects.databasePath(projectId);
    const directory = dirname(database);
    const projectIdentity = await directoryIdentity(directory);
    const databaseIdentity = await ordinaryFileState(database);
    const assertCurrent = () => {
      if (
        this.store.root !== root ||
        this.projects.summary(projectId).folder !== project.folder ||
        !sameFileIdentity(rootIdentity, directoryIdentitySync(root)) ||
        !sameFileIdentity(projectIdentity, directoryIdentitySync(directory)) ||
        !sameFileIdentity(databaseIdentity, ordinaryFileStateSync(database)) ||
        realpathSync(database) !== resolve(database)
      )
        throw changed();
    };
    const snapshot = () => {
      assertCurrent();
      // A complete stage cannot bypass a missing, foreign or unavailable project.
      const current = readProject(database, this.projects.summary(projectId));
      assertCurrent();
      return current;
    };
    return { directory, snapshot, initial: snapshot() };
  }

  async acquire(
    projectId: string,
    assetId: string,
    expectedKind?: Asset['kind'],
    signal?: AbortSignal,
  ): Promise<OpenedProjectMedia | null> {
    signal?.throwIfAborted();
    if (!isId(projectId) || !isId(assetId)) return null;
    const context = await this.context(projectId);
    const asset = context.initial.assets.find((item) => item.id === assetId);
    if (asset) {
      if (expectedKind && asset.kind !== expectedKind) return null;
      return this.committed(context, asset);
    }
    if (!this.stagingDirectory) return null;
    const job = this.store.jobs().find((item) => item.id === assetId);
    if (
      !job ||
      job.projectId !== projectId ||
      !completeLocalReference(job) ||
      (expectedKind && job.kind !== expectedKind)
    )
      return null;
    try {
      return await this.staged(context, job, this.stagingDirectory, signal);
    } catch (error) {
      signal?.throwIfAborted();
      // The queue may commit and unlink .ready while it is being verified.
      // Retry only a freshly authorized committed asset, never an unknown path.
      const current = await this.context(projectId);
      const saved = current.initial.assets.find((item) => item.id === assetId);
      if (!saved || (expectedKind && saved.kind !== expectedKind)) throw error;
      return this.committed(current, saved);
    }
  }

  private async committed(
    context: Awaited<ReturnType<ProjectReferenceReader['context']>>,
    asset: Asset,
  ): Promise<OpenedProjectMedia> {
    validateAsset(asset);
    const file = await safeFile(context.directory, asset.relativePath);
    const directory = dirname(file);
    const parent = await directoryIdentity(directory);
    const before = await ordinaryFileState(file);
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isFile() ||
        !sameFileState(before, opened) ||
        !sameFileIdentity(parent, directoryIdentitySync(directory)) ||
        !sameFileState(opened, ordinaryFileStateSync(file)) ||
        realpathSync(file) !== resolve(file) ||
        JSON.stringify(
          context.snapshot().assets.find((item) => item.id === asset.id),
        ) !== JSON.stringify(asset)
      )
        throw changed();
      return { handle, filename: asset.relativePath, source: 'committed' };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async staged(
    context: Awaited<ReturnType<ProjectReferenceReader['context']>>,
    job: SaveJob,
    directory: string,
    signal?: AbortSignal,
  ): Promise<OpenedProjectMedia> {
    const parent = await directoryIdentity(directory);
    const file = join(directory, `${job.id}.ready`);
    const before = await ordinaryFileState(file);
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        opened.size !== BigInt(job.size) ||
        !sameFileState(before, opened)
      )
        throw changed();
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let size = 0;
      while (size < job.size) {
        signal?.throwIfAborted();
        // Explicit offsets leave the returned descriptor at byte zero.
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, job.size - size),
          size,
        );
        if (!bytesRead) throw changed();
        hash.update(buffer.subarray(0, bytesRead));
        size += bytesRead;
      }
      signal?.throwIfAborted();
      const after = await handle.stat({ bigint: true });
      const current = this.store.job(job.id);
      if (
        hash.digest('hex') !== job.sha256 ||
        after.nlink !== 1n ||
        !sameFileState(opened, after) ||
        !sameFileIdentity(parent, directoryIdentitySync(directory)) ||
        !sameFileState(after, ordinaryFileStateSync(file)) ||
        realpathSync(file) !== resolve(file) ||
        !completeLocalReference(current) ||
        !sameReference(job, current) ||
        context.snapshot().assets.some((asset) => asset.id === job.id)
      )
        throw changed();
      // A descriptor retains these bytes if save cleanup or migration unlinks
      // the name later. No source file, job, draft or saved flag is changed here.
      return {
        handle,
        filename: `reference.${job.extension}`,
        source: 'staged',
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}
