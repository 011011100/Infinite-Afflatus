import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { LibraryState } from '../../shared/models';
import { MigrationService } from '../migration/migration-service';
import { ProjectService } from '../projects/project-service';
import { SaveQueue } from '../saving/save-queue';
import { type GeneratedResult, Staging } from '../saving/staging';
import { InteractionSettingsStore } from '../settings/interaction-settings';
import { AppStore } from './app-store';
import { canonicalDirectory, overlaps } from './files';
import { WriteGate } from './write-gate';

/** Main-process composition root. Feature modules depend on narrow services, never on Electron. */
export class Library {
  readonly projects: ProjectService;
  readonly interactions: InteractionSettingsStore;
  readonly staging: Staging;
  readonly saves: SaveQueue;
  readonly migration: MigrationService;
  readonly gate = new WriteGate();
  private listeners = new Set<() => void>();
  private closing: Promise<void> | null = null;
  get isClosing(): boolean {
    return this.closing !== null;
  }

  private constructor(
    readonly store: AppStore,
    userData: string,
    quota?: number,
  ) {
    this.interactions = new InteractionSettingsStore(store);
    this.projects = new ProjectService(store, this.gate);
    this.staging = new Staging(
      join(userData, 'staging'),
      store,
      () => this.emit(),
      quota,
    );
    this.saves = new SaveQueue(
      store,
      this.projects,
      this.gate,
      this.staging,
      () => this.emit(),
    );
    this.migration = new MigrationService(
      store,
      this.projects,
      this.gate,
      userData,
      () => this.emit(),
      () => this.saves.kick(),
    );
  }

  static async open(
    userData: string,
    defaultRoot: string,
    quota?: number,
  ): Promise<Library> {
    await mkdir(userData, { recursive: true });
    const appFile = join(userData, 'app.sqlite');
    const existing = await lstat(appFile).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      },
    );
    if (existing?.isSymbolicLink()) throw new Error('应用数据库不能是符号链接');
    if (!existing) await mkdir(defaultRoot, { recursive: true });
    const canonicalUserData = await canonicalDirectory(userData);
    const store = new AppStore(appFile, defaultRoot);
    try {
      // Never silently replace an unavailable chosen volume with an empty folder.
      const root = await canonicalDirectory(store.root);
      store.set('root', root);
      if (
        overlaps(root, canonicalUserData) ||
        overlaps(canonicalUserData, root)
      )
        throw new Error('项目目录不能与应用数据目录相互包含');
      const library = new Library(store, canonicalUserData, quota);
      await library.migration.recover();
      await library.projects.discover();
      await library.staging.recover();
      library.saves.start();
      return library;
    } catch (error) {
      store.close();
      throw error;
    }
  }

  state(): LibraryState {
    return {
      root: this.store.root,
      interactions: this.interactions.get(),
      projects: this.store.projects(),
      jobs: this.store
        .jobs()
        .filter((job, index) => job.status !== 'saved' || index < 100),
      migration: this.migration.journal?.status ?? null,
      writeBlocked: this.gate.isBlocked,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error('Library observer failed:', error);
      }
    }
  }

  /** Provider adapters hand off result bytes here; they never receive a project directory. */
  async acceptResult(result: GeneratedResult, stream: Readable) {
    if (this.isClosing) {
      stream.destroy();
      throw new Error('应用正在关闭，请重新打开后导入');
    }
    const job = await this.staging.receive(result, stream);
    this.saves.kick();
    return job;
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    await this.staging.idle();
    await this.migration.idle();
    await this.saves.idle();
    await this.gate.idle();
    this.store.close();
  }
}
