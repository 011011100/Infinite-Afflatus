import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppBackupInfo } from '../../shared/app-backup';
import type { MigrationPreview } from '../../shared/models';
import type { MigrationJournal } from '../migration/manifest';
import type { AppStore } from '../storage/app-store';
import { verifyAppStore } from '../storage/app-store-guard';
import { openDatabase } from '../storage/database';
import { fingerprint, syncDirectory } from '../storage/files';
import type { WriteGate } from '../storage/write-gate';
import {
  BackupAnchorStore,
  GENERATION_KEY,
  generationToken,
  sameAnchor,
  stableAnchor,
} from './backup-anchor';
import {
  assertStableMigration,
  type BackupManifest,
  backupCatalog,
  backupInfo,
  RECOVERY_REPORT_KEY,
  readApplicationSnapshot,
  readRecoveryReport,
} from './backup-catalog';
import {
  BACKUP_DIRECTORY,
  childDirectory,
  directoryIdentity,
  info,
  MAX_DATABASE_BYTES,
  RETAINED_DIRECTORY,
  UUID,
  verifyDirectory,
  writeJson,
} from './backup-files';

/** This is an application index/settings snapshot, never a media or draft backup. */
export class AppBackupService {
  private readonly anchors: BackupAnchorStore;
  private closing = false;
  private active = new Set<Promise<unknown>>();
  constructor(
    private store: AppStore,
    private userData: string,
    private gate: WriteGate,
    private appVersion = 'development',
  ) {
    this.anchors = new BackupAnchorStore(userData, store);
  }
  initialize() {
    return this.anchors.initialize();
  }
  beforeMigration(preview: MigrationPreview) {
    return this.anchors.beforeMigration(preview);
  }
  migrationStarted(preview: MigrationPreview) {
    return this.anchors.migrationStarted(preview);
  }
  beforeCutover(journal: MigrationJournal) {
    return this.anchors.beforeCutover(journal);
  }
  afterCutover() {
    return this.anchors.afterCutover();
  }
  afterMigration() {
    return this.anchors.afterMigration();
  }
  list() {
    return this.track(() =>
      backupCatalog(this.userData, this.store.get(RECOVERY_REPORT_KEY)),
    );
  }
  backupDirectory() {
    return this.track(() => childDirectory(this.userData, BACKUP_DIRECTORY));
  }
  retainedDirectory() {
    return this.track(async () => {
      const report = await readRecoveryReport(
        this.userData,
        this.store.get(RECOVERY_REPORT_KEY),
      );
      if (!report) throw new Error('当前没有应用索引恢复保留资料');
      const parent = join(this.userData, RETAINED_DIRECTORY);
      await directoryIdentity(parent);
      const id = report.retainedDirectory.slice(parent.length + 1);
      if (!UUID.test(id) || join(parent, id) !== report.retainedDirectory)
        throw new Error('恢复保留位置无效');
      await directoryIdentity(report.retainedDirectory);
      return report.retainedDirectory;
    });
  }
  create(): Promise<AppBackupInfo> {
    return this.track(() =>
      this.gate.run(async () => {
        const anchor = await stableAnchor(this.userData);
        if (this.store.root !== anchor.root.path)
          throw new Error('项目目录已变化，未建立旧索引备份');
        const migration = this.store.get<{ status?: { phase?: string } }>(
          'migration',
        );
        if (
          migration &&
          !['completed', 'failed', 'cancelled'].includes(
            migration.status?.phase ?? '',
          )
        )
          throw new Error('目录迁移尚未完成，请完成后建立备份');
        const parent = await childDirectory(this.userData, BACKUP_DIRECTORY);
        const parentIdentity = await directoryIdentity(parent);
        const id = randomUUID();
        const temporary = join(parent, `.creating-${id}`);
        await mkdir(temporary, { mode: 0o700 });
        await syncDirectory(parent);
        const owned = await directoryIdentity(temporary);
        const database = join(temporary, 'app.sqlite');
        // Failed or interrupted exclusive working directories remain visible in list().issues.
        // No recursive deletion can accidentally remove a replaced directory or user file.
        await this.store.snapshot(database);
        // sqlite.backup preserves the source journal-mode header. Normalize only
        // this exclusively owned copy so a WAL source still yields one self-contained file.
        const checkpoint = openDatabase(database, false, verifyAppStore);
        checkpoint.close();
        const size = await info(database);
        if (!size || size.size > BigInt(MAX_DATABASE_BYTES))
          throw new Error('应用索引超过 512 MB，未发布备份');
        const snapshot = readApplicationSnapshot(database);
        assertStableMigration(snapshot);
        if (
          JSON.stringify(snapshot.settings[GENERATION_KEY]) !==
          JSON.stringify(generationToken(anchor))
        )
          throw new Error('应用数据库恢复代际不符，未发布旧索引备份');
        const digest = await fingerprint(database);
        const handle = await open(
          database,
          constants.O_RDWR | constants.O_NOFOLLOW,
        );
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        const manifest: BackupManifest = {
          format: 'infinite-afflatus-app-index-backup',
          version: 1,
          schemaVersion: 1,
          id,
          createdAt: new Date().toISOString(),
          appVersion: this.appVersion,
          anchor,
          bytes: digest.size,
          sha256: digest.sha256,
          projectCount: snapshot.projects.length,
          saveCount: snapshot.jobs.length,
        };
        if (
          snapshot.root !== anchor.root.path ||
          !sameAnchor(anchor, await stableAnchor(this.userData))
        )
          throw new Error('备份期间项目目录代际已变化，未发布');
        await writeJson(join(temporary, 'manifest.json'), manifest, null);
        await verifyDirectory(owned);
        await verifyDirectory(parentIdentity);
        const destination = join(parent, id);
        if (await info(destination)) throw new Error('备份目标已存在，未覆盖');
        await rename(temporary, destination);
        await syncDirectory(parent);
        return backupInfo(manifest, null);
      }),
    );
  }
  private track<T>(run: () => Promise<T>): Promise<T> {
    if (this.closing)
      return Promise.reject(new Error('应用正在关闭，未开始备份操作'));
    const operation = run().finally(() => this.active.delete(operation));
    this.active.add(operation);
    return operation;
  }
  async close() {
    this.closing = true;
    await Promise.allSettled([...this.active]);
  }
}
