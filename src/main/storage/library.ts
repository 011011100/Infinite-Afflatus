import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { LibraryState } from '../../shared/models';
import { AppBackupRecovery } from '../backups/app-backup-recovery';
import { AppBackupService } from '../backups/app-backup-service';
import { preflightBackupAnchor } from '../backups/backup-open-check';
import { ProjectEditDraftService } from '../drafts/project-edit-draft-service';
import { RescueImportService } from '../drafts/rescue-import-service';
import { WorkspaceDraftService } from '../drafts/workspace-draft-service';
import { SequenceExportService } from '../export/sequence-export-service';
import { GenerationService } from '../generation/generation-service';
import { ReferenceImportService } from '../generation/reference-import-service';
import { MediaToolSettings } from '../media/media-tool-settings';
import { ProxyService } from '../media/proxy-service';
import { MigrationService } from '../migration/migration-service';
import { ProjectPackageService } from '../packages/project-package-service';
import { ProjectService } from '../projects/project-service';
import { ProjectHealthService } from '../recovery/project-health-service';
import { RootRelocationService } from '../relocation/root-relocation-service';
import { SaveQueue } from '../saving/save-queue';
import { savedResultVerifier } from '../saving/saved-result-verifier';
import {
  type GeneratedResult,
  Staging,
  type StagingReceiveControls,
} from '../saving/staging';
import { StagingCleanupService } from '../saving/staging-cleanup-service';
import { InteractionSettingsStore } from '../settings/interaction-settings';
import { AppStore } from './app-store';
import { readAppStoreRoot } from './app-store-guard';
import { canonicalDirectory, overlaps, safeFile } from './files';
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
  readonly backups: AppBackupService;
  readonly generation: GenerationService;
  readonly interactions: InteractionSettingsStore;
  readonly mediaTools: MediaToolSettings;
  readonly staging: Staging;
  readonly stagingCleanup: StagingCleanupService;
  readonly saves: SaveQueue;
  readonly migration: MigrationService;
  readonly proxies: ProxyService;
  readonly exports: SequenceExportService;
  readonly packages: ProjectPackageService;
  readonly health: ProjectHealthService;
  readonly drafts: WorkspaceDraftService;
  readonly editDrafts: ProjectEditDraftService;
  readonly rescueImports: RescueImportService;
  readonly referenceImports: ReferenceImportService;
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
    appVersion = 'development',
  ) {
    this.drafts = new WorkspaceDraftService(userData);
    this.editDrafts = new ProjectEditDraftService(userData);
    this.interactions = new InteractionSettingsStore(store);
    this.mediaTools = new MediaToolSettings(store);
    this.projects = new ProjectService(store, this.gate);
    this.backups = new AppBackupService(store, userData, this.gate, appVersion);
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
      undefined,
      () => this.mediaTools.snapshot(),
    );
    this.generation = new GenerationService(this.projects, store, this.gate);
    this.rescueImports = new RescueImportService(this.drafts, this.editDrafts, {
      summary: (id) => this.projects.summary(id),
      read: (id) => this.projects.open(id),
      readWorkspace: (id) => this.generation.readWorkspace(id),
      databasePath: (id) => this.projects.databasePath(id),
      resolveAsset: (id, asset) =>
        safeFile(
          store.root,
          `${this.projects.summary(id).folder}/${asset.relativePath}`,
        ),
      assertAvailable: () => {
        if (this.isClosing) throw new Error('应用正在关闭，请重新打开后导入');
        if (
          this.gate.isBlocked ||
          this.migration.journal?.status.restartRequired
        )
          throw new Error('项目目录正在切换，请完成目录恢复后再导入恢复文件');
      },
      run: (operation) => this.gate.run(operation),
    });
    this.proxies = new ProxyService(
      this.projects,
      this.gate,
      store,
      userData,
      undefined,
      () => this.mediaTools.snapshot(),
    );
    this.staging = new Staging(
      join(userData, 'staging'),
      store,
      () => this.emit(),
      quota,
      savedResultVerifier(store, this.projects),
    );
    this.saves = new SaveQueue(
      store,
      this.projects,
      this.gate,
      this.staging,
      () => this.emit(),
    );
    this.stagingCleanup = new StagingCleanupService(this.staging, store, () =>
      this.emit(),
    );
    this.referenceImports = new ReferenceImportService(
      {
        acceptResult: (result, stream, controls) =>
          this.acceptResult(result, stream, controls),
      },
      this.saves,
    );
    this.migration = new MigrationService(
      store,
      this.projects,
      this.gate,
      userData,
      () => this.emit(),
      () => this.saves.kick(),
      this.backups,
    );
  }

  static async open(
    userData: string,
    defaultRoot: string,
    quota?: number,
    appVersion = 'development',
  ): Promise<Library> {
    let store: AppStore | null = null;
    let recordedRoot: string | null = null;
    let stage: LibraryOpenError['stage'] = 'application';
    try {
      await mkdir(userData, { recursive: true });
      const canonicalUserData = await canonicalDirectory(userData);
      await new RootRelocationService(canonicalUserData).resumePending();
      await new AppBackupRecovery(
        canonicalUserData,
        appVersion,
      ).resumePending();
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
      if (existing) await preflightBackupAnchor(canonicalUserData, appFile);
      store = new AppStore(appFile, root, {
        mode: existing ? 'existing' : 'create',
        ...(existing ? { expected: existing } : {}),
      });
      if (store.root !== root) store.set('root', root);
      const library = new Library(store, canonicalUserData, quota, appVersion);
      stage = 'recovery';
      await library.backups.initialize();
      await library.migration.recover();
      await library.backups.afterMigration();
      await library.packages.recover();
      await library.health.recover();
      await library.projects.discover();
      await library.staging.recover();
      await library.stagingCleanup.recover();
      await library.proxies.recover();
      await library.exports.recover();
      library.saves.start();
      return library;
    } catch (error) {
      await store?.close();
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
  async acceptResult(
    result: GeneratedResult,
    stream: Readable,
    controls?: StagingReceiveControls,
  ) {
    if (this.isClosing) {
      stream.destroy();
      throw new Error('应用正在关闭，请重新打开后导入');
    }
    const job = await this.staging.receive(result, stream, controls);
    this.saves.kick();
    return job;
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    // A reference save can be queued behind any of these gate holders. Signal
    // every cancellation before waiting, and observe every cleanup outcome.
    // Fully received results remain durable and resume on the next library open.
    const stopped = await Promise.allSettled([
      this.rescueImports.close(),
      this.backups.close(),
      this.mediaTools.close(),
      this.referenceImports.close(),
      this.stagingCleanup.close(),
      this.health.close(),
      this.packages.close(),
      this.exports.close(),
    ]);
    const errors = stopped.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, '后台任务未能安全停止');
    await this.proxies.close();
    await this.staging.idle();
    await this.migration.idle();
    await this.saves.idle();
    await this.gate.idle();
    await this.drafts.close();
    await this.editDrafts.close();
    await this.store.close();
  }
}
