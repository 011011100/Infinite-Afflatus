import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { LibraryState } from '../../shared/models';
import { WorkspaceDraftService } from '../drafts/workspace-draft-service';
import { SequenceExportService } from '../export/sequence-export-service';
import { GenerationService } from '../generation/generation-service';
import { ProxyService } from '../media/proxy-service';
import { MigrationService } from '../migration/migration-service';
import { ProjectPackageService } from '../packages/project-package-service';
import { ProjectService } from '../projects/project-service';
import { ProjectHealthService } from '../recovery/project-health-service';
import { SaveQueue } from '../saving/save-queue';
import { type GeneratedResult, Staging } from '../saving/staging';
import { InteractionSettingsStore } from '../settings/interaction-settings';
import { AppStore } from './app-store';
import { readAppStoreRoot } from './app-store-guard';
import { canonicalDirectory, overlaps } from './files';
import { LibraryOpenError } from './library-open-error';
import {
  pathInfo,
  requireCleanProfile,
  requireWritableDirectory,
} from './startup-checks';
import { WriteGate } from './write-gate';

/** Main-process composition root. Feature modules depend on narrow services, never on Electron. */
export class Library {
  readonly projects: ProjectService;
  readonly generation: GenerationService;
  readonly interactions: InteractionSettingsStore;
  readonly staging: Staging;
  readonly saves: SaveQueue;
  readonly migration: MigrationService;
  readonly proxies: ProxyService;
  readonly exports: SequenceExportService;
  readonly packages: ProjectPackageService;
  readonly health: ProjectHealthService;
  readonly drafts: WorkspaceDraftService;
  readonly gate = new WriteGate();
  private listeners = new Set<() => void>();
  private exportListeners = new Set<() => void>();
  private closing: Promise<void> | null = null;
  get isClosing(): boolean {
    return this.closing !== null;
  }

  private constructor(
    readonly store: AppStore,
    userData: string,
    quota?: number,
  ) {
    this.drafts = new WorkspaceDraftService(userData);
    this.interactions = new InteractionSettingsStore(store);
    this.projects = new ProjectService(store, this.gate);
    this.health = new ProjectHealthService(
      this.projects,
      store,
      this.gate,
      userData,
    );
    this.packages = new ProjectPackageService(
      this.projects,
      store,
      this.gate,
      userData,
    );
    this.exports = new SequenceExportService(
      this.projects,
      this.gate,
      store,
      userData,
      () => {
        for (const listener of this.exportListeners) listener();
      },
    );
    this.generation = new GenerationService(this.projects, store, this.gate);
    this.proxies = new ProxyService(this.projects, this.gate, store, userData);
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
    let store: AppStore | null = null;
    let recordedRoot: string | null = null;
    let stage: LibraryOpenError['stage'] = 'application';
    try {
      await mkdir(userData, { recursive: true });
      const canonicalUserData = await canonicalDirectory(userData);
      const appFile = join(canonicalUserData, 'app.sqlite');
      const existing = await pathInfo(appFile);
      if (existing) recordedRoot = readAppStoreRoot(appFile, existing);
      else {
        await requireCleanProfile(canonicalUserData, defaultRoot);
        await mkdir(defaultRoot, { recursive: true });
      }
      stage = 'projects';
      // Never silently replace an unavailable chosen volume with an empty folder.
      const root = await canonicalDirectory(recordedRoot ?? defaultRoot);
      if (
        overlaps(root, canonicalUserData) ||
        overlaps(canonicalUserData, root)
      )
        throw new Error('项目目录不能与应用数据目录相互包含');
      await requireWritableDirectory(root);
      stage = 'application';
      store = new AppStore(appFile, root, {
        mode: existing ? 'existing' : 'create',
        ...(existing ? { expected: existing } : {}),
      });
      if (store.root !== root) store.set('root', root);
      const library = new Library(store, canonicalUserData, quota);
      stage = 'recovery';
      await library.migration.recover();
      await library.packages.recover();
      await library.health.recover();
      await library.projects.discover();
      await library.staging.recover();
      await library.proxies.recover();
      await library.exports.recover();
      library.saves.start();
      return library;
    } catch (error) {
      store?.close();
      throw new LibraryOpenError(error, userData, recordedRoot, stage);
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
  subscribeExports(listener: () => void): () => void {
    this.exportListeners.add(listener);
    return () => {
      this.exportListeners.delete(listener);
    };
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
    this.packages.cancel();
    await this.health.close();
    await this.packages.close();
    await this.exports.close();
    await this.proxies.close();
    await this.staging.idle();
    await this.migration.idle();
    await this.saves.idle();
    await this.gate.idle();
    await this.drafts.close();
    this.store.close();
  }
}
