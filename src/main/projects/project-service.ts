import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CanvasPatch } from '../../shared/canvas/model';
import type {
  Asset,
  ProjectSnapshot,
  ProjectSummary,
  Viewport,
} from '../../shared/models';
import type { ProjectRecoverySnapshot } from '../../shared/project-recovery';
import type { AppStore } from '../storage/app-store';
import { inside, safeFile, syncDirectory } from '../storage/files';
import type { WriteGate } from '../storage/write-gate';
import {
  createProjectDatabase,
  patchProjectCanvas,
  readProject,
  updateProject,
} from './project-database';

export class ProjectService {
  constructor(
    private readonly store: AppStore,
    private readonly gate: WriteGate,
  ) {}

  summary(id: string): ProjectSummary {
    const project = this.store.projects().find((item) => item.id === id);
    if (!project) throw new Error('项目不存在');
    return project;
  }

  async databasePath(id: string): Promise<string> {
    const project = this.summary(id);
    return safeFile(this.store.root, `${project.folder}/project.sqlite`);
  }

  async open(id: string): Promise<ProjectSnapshot> {
    return readProject(await this.databasePath(id), this.summary(id));
  }

  async readRecovery(id: string): Promise<ProjectRecoverySnapshot> {
    const database = await this.databasePath(id);
    // SaveQueue records the asset and its saved acknowledgement synchronously.
    // Keep these reads in the same turn so a newer job cannot authorize an older
    // snapshot, or look like a missing asset merely because it finished later.
    const snapshot = readProject(database, this.summary(id));
    const savedReferenceAssets: Asset[] = this.store.jobs().flatMap((job) =>
      job.projectId === id &&
      job.status === 'saved' &&
      job.usage === 'reference' &&
      job.resultKey.startsWith('reference:') &&
      job.outputRelativePath &&
      /^[a-f0-9]{64}$/.test(job.sha256)
        ? [
            {
              id: job.id,
              name: job.name,
              relativePath: job.outputRelativePath,
              size: job.size,
              sha256: job.sha256,
              kind: job.kind,
              usage: 'reference' as const,
            },
          ]
        : [],
    );
    return { snapshot, savedReferenceAssets };
  }

  async create(name: string): Promise<ProjectSnapshot> {
    return this.gate.run(async () => {
      const id = randomUUID();
      const project: ProjectSummary = {
        id,
        name: validateName(name),
        folder: id,
        updatedAt: new Date().toISOString(),
      };
      const directory = inside(this.store.root, id);
      await mkdir(directory);
      for (const folder of ['assets/videos', 'assets/images', 'cache']) {
        await mkdir(join(directory, folder), { recursive: true });
      }
      createProjectDatabase(join(directory, 'project.sqlite'), project);
      await syncDirectory(directory);
      await syncDirectory(this.store.root);
      this.store.putProject(project);
      return this.open(id);
    });
  }

  async update(
    id: string,
    changes: { name?: string; viewport?: Viewport },
  ): Promise<void> {
    if (changes.name !== undefined) changes.name = validateName(changes.name);
    if (changes.viewport) validateViewport(changes.viewport);
    await this.gate.run(async () => {
      this.store.putProject(
        updateProject(await this.databasePath(id), changes, this.summary(id)),
      );
    });
  }

  async patchCanvas(id: string, patch: CanvasPatch): Promise<ProjectSnapshot> {
    return this.gate.run(async () => {
      const snapshot = patchProjectCanvas(
        await this.databasePath(id),
        patch,
        this.summary(id),
      );
      this.store.putProject(snapshot.project);
      return snapshot;
    });
  }

  /** Recover the recent-project index from self-contained project folders. */
  async discover(): Promise<void> {
    for (const entry of await readdir(this.store.root, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !isId(entry.name)) continue;
      try {
        const snapshot = readProject(
          await safeFile(this.store.root, `${entry.name}/project.sqlite`),
        );
        if (
          snapshot.project.id !== entry.name ||
          snapshot.project.folder !== entry.name
        )
          continue;
        this.store.putProject(snapshot.project);
      } catch {
        /* Unrecognized, newer or damaged files are never adopted or modified. */
      }
    }
  }
}

export function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

export function validateName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 100 ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw new Error('项目名称需要 1–100 个字符，且不能包含控制字符');
  }
  return value.trim();
}

export function validateViewport(value: Viewport): void {
  if (
    !value ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    !Number.isFinite(value.zoom) ||
    Math.abs(value.x) > 1e8 ||
    Math.abs(value.y) > 1e8 ||
    value.zoom < 0.25 ||
    value.zoom > 2
  ) {
    throw new Error('画布位置无效');
  }
}
