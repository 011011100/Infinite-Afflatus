import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  link,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AppBackupRecoveryReport,
  AppBackupRestorePreview,
  AppBackupRestoreResult,
} from '../../shared/app-backup';
import { RELOCATION_FILE } from '../relocation/root-relocation-types';
import { verifyAppStore } from '../storage/app-store-guard';
import { openDatabase, transaction } from '../storage/database';
import { syncDirectory } from '../storage/files';
import {
  type BackupAnchor,
  decodeAnchor,
  GENERATION_KEY,
  generationToken,
  sameAnchor,
  stableAnchor,
} from './backup-anchor';
import {
  assertStableMigration,
  backupCatalog,
  backupInfo,
  RECOVERY_REPORT_KEY,
  readBackup,
} from './backup-catalog';
import {
  ANCHOR_FILE,
  childDirectory,
  type DirectoryIdentity,
  directoryIdentity,
  info,
  RESTORE_FILE,
  RETAINED_DIRECTORY,
  readJson,
  removeJson,
  UUID,
  validIdentity,
  verifyDirectory,
  writeJson,
} from './backup-files';
import {
  type FileEvidence,
  fileEvidence,
  inspectRestore,
  type RestoreInspection,
} from './restore-inspection';

const TTL = 2 * 60 * 1000;
const WARNING =
  '仅恢复应用索引与设置。项目和素材仍使用原目录；旧保存任务与操作记录已隔离，不会自动重试或清理。全部现有暂存文件及独立草稿留在原位置，本备份不包含它们的内容。';
const DB_FILES = [
  'app.sqlite',
  'app.sqlite-journal',
  'app.sqlite-wal',
  'app.sqlite-shm',
] as const;
interface RestoreIntent {
  format: 'infinite-afflatus-app-index-restore';
  version: 1;
  id: string;
  backupId: string;
  anchor: BackupAnchor;
  resultAnchor: BackupAnchor;
  retained: DirectoryIdentity;
  candidate: FileEvidence;
  original: Record<string, FileEvidence | null>;
  files: Record<string, FileEvidence>;
  staging: RestoreInspection['staging'];
  report: AppBackupRecoveryReport;
}
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function validEvidence(value: unknown): value is FileEvidence {
  const item = value as FileEvidence;
  return (
    validIdentity(item) &&
    typeof item.size === 'string' &&
    /^\d+$/.test(item.size) &&
    typeof item.modified === 'string' &&
    /^-?\d+$/.test(item.modified) &&
    typeof item.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(item.sha256)
  );
}

/** Offline-only: no Library, workers or writable original SQLite connection may be active. */
export class AppBackupRecovery {
  private previewState: {
    preview: AppBackupRestorePreview;
    evidence: RestoreInspection;
    backupHash: string;
  } | null = null;
  private busy = false;
  constructor(
    private userData: string,
    private appVersion = 'development',
  ) {}
  async list() {
    return backupCatalog(this.userData);
  }
  private async location() {
    const canonical = await realpath(this.userData);
    await directoryIdentity(canonical);
    this.userData = canonical;
    return canonical;
  }
  async preview(id: string): Promise<AppBackupRestorePreview> {
    if (this.busy) throw new Error('应用索引恢复正在进行');
    this.previewState = null;
    await this.location();
    if (await info(join(this.userData, RESTORE_FILE)))
      throw new Error('上次应用索引恢复尚未完成，请先重试读取');
    const backup = await readBackup(this.userData, id);
    assertStableMigration(backup.snapshot);
    const evidence = await inspectRestore(
      this.userData,
      backup.snapshot.projects,
    );
    if (!sameAnchor(evidence.anchor, backup.manifest.anchor))
      throw new Error('备份与当前资料目录或项目目录代际不符，未恢复旧索引');
    const preview: AppBackupRestorePreview = {
      token: randomUUID(),
      expiresAt: new Date(Date.now() + TTL).toISOString(),
      backup: backupInfo(backup.manifest, null),
      projectCount: evidence.projects.length,
      retainedJobCount: backup.snapshot.jobs.length,
      retainedFileCount: evidence.staging.length,
      warnings: [WARNING],
    };
    this.previewState = {
      preview,
      evidence,
      backupHash: backup.manifest.sha256,
    };
    return preview;
  }
  async restore(token: string): Promise<AppBackupRestoreResult> {
    const pending = this.previewState;
    if (
      this.busy ||
      !pending ||
      token !== pending.preview.token ||
      Date.now() > Date.parse(pending.preview.expiresAt)
    )
      throw new Error('应用恢复预览已失效，请重新检查');
    this.previewState = null;
    this.busy = true;
    try {
      const backup = await readBackup(this.userData, pending.preview.backup.id);
      assertStableMigration(backup.snapshot);
      const evidence = await inspectRestore(
        this.userData,
        backup.snapshot.projects,
      );
      if (
        backup.manifest.sha256 !== pending.backupHash ||
        !same(evidence, pending.evidence) ||
        !sameAnchor(evidence.anchor, backup.manifest.anchor)
      )
        throw new Error('应用恢复范围在确认后变化，请重新检查；原资料未修改');
      if (await info(join(this.userData, RESTORE_FILE)))
        throw new Error('已有未完成的应用恢复');
      const parent = await childDirectory(this.userData, RETAINED_DIRECTORY);
      const id = randomUUID();
      const path = join(parent, id);
      await mkdir(path, { mode: 0o700 });
      await syncDirectory(parent);
      const retained = await directoryIdentity(path);
      const resultAnchor: BackupAnchor = {
        ...evidence.anchor,
        generation: randomUUID(),
      };
      const report: AppBackupRecoveryReport = {
        restoredAt: new Date().toISOString(),
        backupId: backup.manifest.id,
        retainedDirectory: path,
        retainedJobCount: backup.snapshot.jobs.length,
        retainedFileCount: evidence.staging.length,
        warning: WARNING,
      };
      // Preserve every old operation field and task row as data, not live instructions.
      await writeJson(
        join(path, 'retained-state.json'),
        {
          format: 'infinite-afflatus-retained-app-state',
          version: 1,
          appVersion: this.appVersion,
          report,
          snapshot: backup.snapshot,
          staging: evidence.staging,
          original: evidence.current,
        },
        null,
      );
      const candidatePath = join(path, 'new-app.sqlite');
      await copyFile(backup.database, candidatePath, constants.COPYFILE_EXCL);
      const copied = await fileEvidence(candidatePath);
      if (
        !copied ||
        copied.sha256 !== backup.manifest.sha256 ||
        copied.size !== String(backup.manifest.bytes)
      )
        throw new Error('备份在复制期间变化，原资料未修改');
      const db = openDatabase(candidatePath, false, verifyAppStore);
      try {
        transaction(db, () => {
          verifyAppStore(db);
          db.exec(
            'DELETE FROM saves; DELETE FROM projects; DELETE FROM settings;',
          );
          const put = db.prepare('INSERT INTO settings VALUES (?, ?)');
          put.run('root', evidence.anchor.root.path);
          for (const key of ['interactions', 'mediaToolSettings'])
            if (Object.hasOwn(backup.snapshot.settings, key))
              put.run(key, JSON.stringify(backup.snapshot.settings[key]));
          put.run(RECOVERY_REPORT_KEY, JSON.stringify(report));
          put.run(
            GENERATION_KEY,
            JSON.stringify(generationToken(resultAnchor)),
          );
          const project = db.prepare('INSERT INTO projects VALUES (?, ?)');
          for (const item of evidence.projects)
            project.run(item.id, JSON.stringify(item));
          verifyAppStore(db);
        });
      } finally {
        db.close();
      }
      const handle = await open(
        candidatePath,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      const candidate = await fileEvidence(candidatePath);
      if (!candidate) throw new Error('恢复候选数据库缺失');
      await verifyDirectory(retained);
      // Recheck immediately before authorizing the first move of an original file.
      if (
        !same(
          await inspectRestore(this.userData, backup.snapshot.projects),
          evidence,
        )
      )
        throw new Error('准备恢复期间资料发生变化，原文件已保留');
      const intent: RestoreIntent = {
        format: 'infinite-afflatus-app-index-restore',
        version: 1,
        id,
        backupId: backup.manifest.id,
        anchor: evidence.anchor,
        resultAnchor,
        retained,
        candidate,
        original: evidence.current,
        files: evidence.files,
        staging: evidence.staging,
        report,
      };
      await writeJson(join(this.userData, RESTORE_FILE), intent, null);
      await this.finish(intent);
      return { backupId: intent.backupId, retainedDirectory: path, report };
    } finally {
      this.busy = false;
    }
  }
  async resumePending(): Promise<void> {
    if (this.busy) throw new Error('应用恢复正在进行');
    if (!(await info(this.userData))) return;
    await this.location();
    if (await info(join(this.userData, RELOCATION_FILE)))
      throw new Error('目录重定位尚未完成，不能同时恢复应用索引');
    const file = join(this.userData, RESTORE_FILE);
    if (!(await info(file))) return;
    this.busy = true;
    try {
      await this.finish(this.intent(await readJson(file)));
    } finally {
      this.busy = false;
    }
  }
  private intent(value: unknown): RestoreIntent {
    const item = value as RestoreIntent;
    if (
      item?.format !== 'infinite-afflatus-app-index-restore' ||
      item.version !== 1 ||
      !UUID.test(item.id) ||
      !UUID.test(item.backupId) ||
      !validIdentity(item.retained) ||
      item.retained.path !== join(this.userData, RETAINED_DIRECTORY, item.id) ||
      !validEvidence(item.candidate) ||
      !item.original ||
      Object.keys(item.original).sort().join() !==
        [...DB_FILES].sort().join() ||
      Object.values(item.original).some(
        (entry) => entry !== null && !validEvidence(entry),
      ) ||
      !item.files ||
      !Array.isArray(item.staging) ||
      !item.report ||
      item.report.backupId !== item.backupId ||
      item.report.retainedDirectory !== item.retained.path
    )
      throw new Error('应用恢复意图损坏或版本不受支持，原资料已保留');
    decodeAnchor(item.anchor);
    decodeAnchor(item.resultAnchor);
    if (
      !sameAnchor(
        { ...item.anchor, generation: item.resultAnchor.generation },
        item.resultAnchor,
      ) ||
      item.anchor.generation === item.resultAnchor.generation
    )
      throw new Error('应用恢复目标代际无效');
    // Evidence paths are read-only, but must still be confined to the original managed roots.
    for (const [path, evidence] of Object.entries(item.files)) {
      const allowed =
        path.startsWith(
          `${item.anchor.root.path}${process.platform === 'win32' ? '\\' : '/'}`,
        ) ||
        ['workspace-drafts', 'project-edit-drafts'].some((name) =>
          path.startsWith(
            `${join(this.userData, name)}${process.platform === 'win32' ? '\\' : '/'}`,
          ),
        );
      if (!allowed || !validEvidence(evidence))
        throw new Error('应用恢复校验范围无效');
    }
    return item;
  }
  private async finish(intent: RestoreIntent) {
    this.intent(intent);
    const currentAnchor = await stableAnchor(this.userData);
    if (
      !sameAnchor(intent.anchor, currentAnchor) &&
      !sameAnchor(intent.resultAnchor, currentAnchor)
    )
      throw new Error('应用恢复期间原目录代际已变化');
    await directoryIdentity(join(this.userData, RETAINED_DIRECTORY));
    await verifyDirectory(intent.retained);
    const content = await inspectRestore(this.userData, []);
    if (!same(content.files, intent.files))
      throw new Error('项目或恢复草稿范围在恢复期间变化，原资料已保留');
    if (!same(content.staging, intent.staging))
      throw new Error('暂存范围在恢复期间变化，原资料已保留');
    const candidatePath = join(intent.retained.path, 'new-app.sqlite');
    const destination = join(this.userData, 'app.sqlite');
    const published = same(await fileEvidence(destination), intent.candidate);
    const candidate = await fileEvidence(candidatePath);
    if (!published && !same(candidate, intent.candidate))
      throw new Error('恢复候选数据库已变化，原资料已保留');
    for (const name of DB_FILES) {
      const original = intent.original[name];
      const source = join(this.userData, name);
      const archive = join(intent.retained.path, name);
      const saved = await fileEvidence(archive);
      const current = await fileEvidence(source);
      if (!original) {
        if (saved || (current && !(name === 'app.sqlite' && published)))
          throw new Error('恢复位置出现未登记文件，未覆盖');
        continue;
      }
      if (saved) {
        if (
          !same(saved, original) ||
          (current && !(name === 'app.sqlite' && published))
        )
          throw new Error('原资料归档身份不符，未覆盖');
      } else {
        if (!same(current, original) || published)
          throw new Error('原数据库或日志在恢复期间变化，未覆盖');
        await verifyDirectory(intent.retained);
        await rename(source, archive);
        await syncDirectory(intent.retained.path);
        await syncDirectory(this.userData);
      }
    }
    if (!published) {
      if (await info(destination))
        throw new Error('原数据库位置已出现新文件，未覆盖');
      // Same-volume hard link publishes atomically without replacing an unexpected user file.
      await link(candidatePath, destination);
      await syncDirectory(this.userData);
    }
    if (!same(await fileEvidence(destination), intent.candidate))
      throw new Error('恢复数据库发布校验失败');
    const db = openDatabase(destination, true);
    try {
      verifyAppStore(db);
    } finally {
      db.close();
    }
    if (!sameAnchor(currentAnchor, intent.resultAnchor))
      await writeJson(
        join(this.userData, ANCHOR_FILE),
        intent.resultAnchor,
        intent.anchor,
      );
    if (candidate) {
      if (!same(await fileEvidence(candidatePath), intent.candidate))
        throw new Error('恢复候选文件身份已变化');
      await unlink(candidatePath);
      await syncDirectory(intent.retained.path);
    }
    await removeJson(join(this.userData, RESTORE_FILE), intent);
  }
}
