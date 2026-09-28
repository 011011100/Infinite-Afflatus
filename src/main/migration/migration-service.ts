import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MigrationPreview } from '../../shared/models';
import { verifyProjectDatabase } from '../projects/project-database';
import type { ProjectService } from '../projects/project-service';
import type { AppStore } from '../storage/app-store';
import { errorMessage } from '../storage/database';
import {
  canonicalDirectory,
  checkSpace,
  durableCopy,
  fingerprint,
  inside,
  overlaps,
  safeFile,
  sameContent,
  sameFile,
  syncDirectory,
} from '../storage/files';
import type { WriteGate } from '../storage/write-gate';
import { cleanupMigration } from './cleanup';
import {
  buildManifest,
  directoryIdentity,
  type MigrationJournal,
  sameDirectory,
} from './manifest';

export class MigrationService {
  private preview: MigrationPreview | null = null;
  private work: Promise<void> | null = null;
  private cancelRequested = false;

  constructor(
    private readonly store: AppStore,
    private readonly projects: ProjectService,
    private readonly gate: WriteGate,
    private readonly userData: string,
    private readonly notify: () => void,
    private readonly resumeSaves: () => void,
  ) {}

  get journal(): MigrationJournal | null {
    return this.store.get<MigrationJournal>('migration');
  }

  private persist(journal: MigrationJournal): void {
    this.store.set('migration', journal);
    this.notify();
  }

  async prepare(path: string): Promise<MigrationPreview> {
    if (this.work || this.journal?.status.phase === 'cleaning')
      throw new Error('请先完成当前迁移或重试旧文件清理');
    const target = await canonicalDirectory(path);
    const source = await canonicalDirectory(this.store.root);
    if (
      overlaps(source, target) ||
      overlaps(target, source) ||
      overlaps(this.userData, target) ||
      overlaps(target, this.userData)
    ) {
      throw new Error('新目录不能与当前目录或应用数据目录相互包含');
    }
    if ((await readdir(target)).length)
      throw new Error('请选择一个空文件夹作为新的项目保存目录');
    await this.projects.discover();
    const projects = this.store.projects();
    const files = await buildManifest(
      source,
      this.projects,
      projects.map((project) => project.id),
    );
    const bytes = files.reduce((sum, file) => sum + file.source.size, 0);
    await checkSpace(target, bytes);
    this.preview = {
      token: randomUUID(),
      source,
      target,
      projectCount: projects.length,
      bytes,
    };
    return this.preview;
  }

  async start(token: string): Promise<void> {
    if (
      this.work ||
      !this.preview ||
      token !== this.preview.token ||
      this.preview.source !== this.store.root
    ) {
      throw new Error('目录预览已失效，请重新选择');
    }
    const preview = this.preview;
    this.preview = null;
    this.cancelRequested = false;
    // Admission closes synchronously, before any awaited planning or copying.
    if (this.gate.isBlocked) throw new Error('已有目录任务正在运行');
    const admitted = this.gate.block();
    this.work = admitted
      .then(() => this.perform(preview))
      .finally(() => {
        this.work = null;
        this.gate.release();
        this.notify();
        this.resumeSaves();
      });
    this.notify();
    await admitted;
  }

  private async perform(preview: MigrationPreview): Promise<void> {
    let journal: MigrationJournal | null = null;
    try {
      if (
        (await canonicalDirectory(preview.source)) !== preview.source ||
        (await canonicalDirectory(preview.target)) !== preview.target
      )
        throw new Error('迁移目录路径已变化，请重新选择');
      if ((await readdir(preview.target)).length)
        throw new Error('目标目录已不为空，请重新选择');
      await this.projects.discover();
      const projects = this.store.projects();
      const files = await buildManifest(
        preview.source,
        this.projects,
        projects.map((project) => project.id),
      );
      await checkSpace(
        preview.target,
        files.reduce((sum, item) => sum + item.source.size, 0),
      );
      journal = {
        status: {
          id: randomUUID(),
          source: preview.source,
          target: preview.target,
          phase: 'copying',
          copied: 0,
          total: files.length,
          error: null,
          warnings: [],
        },
        switched: false,
        sourceIdentity: await directoryIdentity(preview.source),
        targetIdentity: await directoryIdentity(preview.target),
        files,
        sourceDirectories: {},
        targetDirectories: {},
      };
      this.persist(journal);
      for (const project of projects) {
        for (const part of [
          '',
          '/assets',
          '/assets/videos',
          '/assets/images',
          '/cache',
        ]) {
          const path = `${project.folder}${part}`;
          try {
            journal.sourceDirectories[path] = await directoryIdentity(
              inside(preview.source, path),
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          await mkdir(inside(preview.target, path));
          await syncDirectory(dirname(inside(preview.target, path)));
          journal.targetDirectories[path] = await directoryIdentity(
            inside(preview.target, path),
          );
          this.persist(journal);
        }
      }
      for (const entry of files) {
        this.checkCancellation();
        const source = await safeFile(preview.source, entry.relativePath);
        const destination = inside(preview.target, entry.relativePath);
        if (
          !sameDirectory(
            await directoryIdentity(dirname(destination)),
            journal.targetDirectories[
              entry.relativePath.substring(
                0,
                entry.relativePath.lastIndexOf('/'),
              )
            ] ?? { device: -1, inode: -1 },
          )
        ) {
          throw new Error('目标目录在复制期间发生变化');
        }
        const copied = await durableCopy(source, destination);
        if (!sameContent(copied, entry.source))
          throw new Error('迁移文件校验失败');
        entry.copied = copied;
        journal.status.copied += 1;
        this.persist(journal);
      }
      journal.status.phase = 'verifying';
      this.persist(journal);
      for (const project of projects)
        verifyProjectDatabase(
          await safeFile(preview.target, `${project.folder}/project.sqlite`),
        );
      for (const entry of files) {
        this.checkCancellation();
        if (
          !sameFile(
            await fingerprint(
              await safeFile(preview.source, entry.relativePath),
            ),
            entry.source,
          ) ||
          !sameContent(
            await fingerprint(
              await safeFile(preview.target, entry.relativePath),
            ),
            entry.source,
          )
        ) {
          throw new Error('迁移期间文件发生变化，仍使用原目录');
        }
      }
      if (
        !sameDirectory(
          await directoryIdentity(preview.source),
          journal.sourceIdentity,
        ) ||
        !sameDirectory(
          await directoryIdentity(preview.target),
          journal.targetIdentity,
        )
      )
        throw new Error('迁移目录已被替换');
      this.checkCancellation();
      await syncDirectory(preview.target);
      journal.switched = true;
      journal.status.phase = 'cleaning';
      // Root switch and recovery direction commit together, in one SQLite transaction.
      this.store.commitLocation(preview.target, journal);
      this.notify();
      await cleanupMigration(journal, () => {
        if (journal) this.persist(journal);
      });
      journal.status.phase = 'completed';
      this.persist(journal);
    } catch (error) {
      if (!journal) {
        this.store.set('migration', {
          status: {
            id: randomUUID(),
            source: preview.source,
            target: preview.target,
            phase: 'failed',
            copied: 0,
            total: 0,
            error: errorMessage(error),
            warnings: [],
          },
          switched: false,
          sourceIdentity: { device: -1, inode: -1 },
          targetIdentity: { device: -1, inode: -1 },
          files: [],
          sourceDirectories: {},
          targetDirectories: {},
        });
        this.notify();
        return;
      }
      journal.status.error = errorMessage(error);
      if (journal.switched) {
        journal.status.phase = 'cleaning';
      } else {
        journal.status.phase = this.cancelRequested ? 'cancelled' : 'failed';
        try {
          await cleanupMigration(journal, () => {
            if (journal) this.persist(journal);
          });
        } catch (cleanupError) {
          journal.status.warnings.push(
            `目标副本保留：${errorMessage(cleanupError)}`,
          );
        }
      }
      this.persist(journal);
    }
  }

  cancel(): void {
    if (this.work) this.cancelRequested = true;
  }
  private checkCancellation(): void {
    if (this.cancelRequested) throw new Error('迁移已取消，继续使用原目录');
  }

  async recover(): Promise<void> {
    const journal = this.journal;
    if (
      !journal ||
      ['completed', 'failed', 'cancelled'].includes(journal.status.phase)
    )
      return;
    if (journal.switched) {
      await this.retryCleanup();
    } else {
      journal.status.phase = 'failed';
      journal.status.error = '上次迁移被中断，继续使用原目录；可重新选择新目录';
      try {
        await cleanupMigration(journal, () => this.persist(journal));
      } catch (error) {
        journal.status.warnings.push(`目标副本保留：${errorMessage(error)}`);
      }
      this.persist(journal);
    }
  }

  async retryCleanup(): Promise<void> {
    const journal = this.journal;
    if (this.work || !journal?.switched || journal.status.phase !== 'cleaning')
      return;
    if (this.gate.isBlocked) throw new Error('已有目录任务正在运行');
    const admitted = this.gate.block();
    this.work = admitted
      .then(async () => {
        try {
          await cleanupMigration(journal, () => this.persist(journal));
          journal.status.phase = 'completed';
          journal.status.error = null;
        } catch (error) {
          journal.status.error = errorMessage(error);
        }
        this.persist(journal);
      })
      .finally(() => {
        this.work = null;
        this.gate.release();
        this.notify();
        this.resumeSaves();
      });
    await this.work;
  }

  async idle(): Promise<void> {
    await this.work;
  }
}
