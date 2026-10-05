import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, rename } from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import type { ProjectSnapshot, ProjectSummary } from '../../shared/models';
import type {
  ProjectPackageExport,
  ProjectPackageInfo,
} from '../../shared/project-package';
import type { ProjectService } from '../projects/project-service';
import { validateName } from '../projects/project-service';
import type { AppStore } from '../storage/app-store';
import {
  checkSpace,
  fingerprint,
  inside,
  overlaps,
  safeFile,
  syncDirectory,
} from '../storage/files';
import type { WriteGate } from '../storage/write-gate';
import {
  adoptPackageDatabase,
  snapshotPackageDatabase,
  validatePackageDatabase,
} from './package-database';
import {
  MAX_DATABASE_BYTES,
  MAX_PACKAGE_BYTES,
  type PackageManifest,
  packProject,
  unpackPackage,
  validateManifest,
} from './package-format';
import {
  PackageCancelledError,
  PackageProgressReporter,
  type ProjectPackageControls,
} from './package-progress';
import { PackageRecovery } from './package-recovery';
import { PackageWork } from './package-work';

export type { ProjectPackageControls } from './package-progress';

/** Whole operations hold the gate, so migrations and shutdown cannot invalidate their paths. */
export class ProjectPackageService {
  private readonly recovery: PackageRecovery;
  private running: Promise<unknown> | null = null;
  private controller: AbortController | null = null;
  private closing = false;
  constructor(
    private readonly projects: ProjectService,
    private readonly store: AppStore,
    private readonly gate: WriteGate,
    private readonly userData: string,
  ) {
    this.recovery = new PackageRecovery(store);
  }

  recover(): Promise<void> {
    if (this.running)
      return Promise.reject(new Error('已有项目包任务正在运行'));
    return this.recovery.clean();
  }

  cancel(): void {
    this.controller?.abort(new PackageCancelledError());
  }

  async close(): Promise<void> {
    this.closing = true;
    this.cancel();
    await this.running?.catch((error: unknown) => {
      if (!(error instanceof PackageCancelledError)) throw error;
    });
  }

  private run<T>(
    operation: (
      signal: AbortSignal,
      progress: PackageProgressReporter,
    ) => Promise<T>,
    controls: ProjectPackageControls = {},
  ): Promise<T> {
    if (this.closing)
      return Promise.reject(new Error('应用正在关闭，无法处理项目包'));
    if (this.running)
      return Promise.reject(
        new Error('已有项目包任务正在运行，请等待完成或取消'),
      );
    const controller = new AbortController();
    this.controller = controller;
    const progress = new PackageProgressReporter(controls.onProgress);
    const abort = () => controller.abort(new PackageCancelledError());
    controls.signal?.addEventListener('abort', abort, { once: true });
    if (controls.signal?.aborted) abort();
    const result = this.gate.run(async () => {
      controller.signal.throwIfAborted();
      progress.update({ phase: 'preparing' });
      return operation(controller.signal, progress);
    });
    const completed = result
      .then(
        (value) => {
          progress.update({ phase: 'completed', canCancel: false });
          return value;
        },
        (error: unknown) => {
          progress.update({
            phase:
              error instanceof PackageCancelledError ? 'cancelled' : 'failed',
            canCancel: false,
          });
          throw error;
        },
      )
      .finally(() => {
        controls.signal?.removeEventListener('abort', abort);
        this.running = null;
        this.controller = null;
      });
    this.running = completed;
    progress.update({ phase: 'waiting' });
    return completed;
  }

  inspect(
    projectId: string,
    controls?: ProjectPackageControls,
  ): Promise<ProjectPackageInfo> {
    return this.run(async (signal, progress) => {
      const database = await this.projects.databasePath(projectId);
      const databaseSize = (await lstat(database)).size;
      if (databaseSize > MAX_DATABASE_BYTES)
        throw new Error('项目数据库体积超出项目包支持范围');
      const { snapshot, entries } = validatePackageDatabase(database);
      if (snapshot.project.id !== projectId)
        throw new Error('项目文件与索引不匹配');
      let bytes = databaseSize;
      progress.update({ phase: 'verifying', totalFiles: entries.length });
      for (const entry of entries) {
        signal.throwIfAborted();
        const path = await safeFile(dirname(database), entry.path);
        if ((await lstat(path)).size !== entry.size)
          throw new Error('项目素材缺失或已改变，请修复后导出');
        bytes += entry.size;
        progress.update({ fileName: entry.path });
        progress.verified();
      }
      signal.throwIfAborted();
      if (bytes > MAX_PACKAGE_BYTES) throw new Error('项目包体积超出支持范围');
      return this.info(snapshot, bytes);
    }, controls);
  }

  export(
    projectId: string,
    destination: string,
    controls?: ProjectPackageControls,
  ): Promise<ProjectPackageExport> {
    return this.run(async (signal, progress) => {
      if (
        typeof destination !== 'string' ||
        !destination.trim() ||
        !isAbsolute(destination) ||
        extname(destination).toLowerCase() !== '.afflatus'
      )
        throw new Error('请选择完整的 .afflatus 项目包文件路径');
      const requested = resolve(destination);
      const path = join(
        await realpath(dirname(requested)),
        basename(requested),
      );
      if (overlaps(this.store.root, path) || overlaps(this.userData, path))
        throw new Error('请将项目包导出到项目库和应用数据目录之外');
      await this.requireMissing(path);
      const work = await PackageWork.create(this.userData, this.recovery);
      const temporary = join(
        dirname(path),
        `.${basename(path)}.${randomUUID()}.part`,
      );
      try {
        const { snapshot, manifest, original } = await this.prepare(
          projectId,
          work,
          signal,
        );
        const bytes = manifest.entries.reduce(
          (sum, entry) => sum + entry.size,
          0,
        );
        await checkSpace(dirname(path), bytes + 8 * 1024 * 1024);
        const output = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await work.registerExternal(temporary, await output.stat());
          await packProject(
            output,
            manifest,
            (entry) =>
              safeFile(
                entry.path === 'project.sqlite' ? work.root : original,
                entry.path,
              ),
            signal,
            progress,
          );
        } finally {
          await output.close();
        }
        signal.throwIfAborted();
        progress.update({
          phase: 'finalizing',
          canCancel: false,
          fileName: null,
        });
        // Publish atomically without ever replacing a prior backup or exposing incomplete bytes.
        try {
          await link(temporary, path);
        } catch (error) {
          if (
            !['ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(
              (error as NodeJS.ErrnoException).code ?? '',
            )
          )
            throw error;
          throw new Error(
            '该磁盘不支持安全发布项目包，请先导出到本机磁盘后再复制',
          );
        }
        await syncDirectory(dirname(path));
        return { ...this.info(snapshot, bytes), path };
      } finally {
        await work.cleanup();
      }
    }, controls);
  }

  import(
    path: string,
    controls?: ProjectPackageControls,
  ): Promise<ProjectSnapshot> {
    return this.run(async (signal, progress) => {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error('项目包不能是符号链接');
      const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let work: PackageWork | undefined;
      try {
        const before = await input.stat();
        if (!before.isFile()) throw new Error('请选择普通项目包文件');
        work = await PackageWork.create(this.store.root, this.recovery);
        const destination = work;
        const manifest = await unpackPackage(
          input,
          work.root,
          (relativePath) => destination.createFile(relativePath),
          signal,
          progress,
        );
        const after = await input.stat();
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
          throw new Error('项目包正在被其他程序修改，请稍后重试');
        const database = join(work.root, 'project.sqlite');
        signal.throwIfAborted();
        progress.update({ phase: 'verifying', fileName: null });
        const { snapshot } = validatePackageDatabase(database, manifest);
        return await this.commit(work, snapshot.project.name, signal, progress);
      } finally {
        await input.close();
        await work?.cleanup();
      }
    }, controls);
  }

  duplicate(
    projectId: string,
    name?: string,
    controls?: ProjectPackageControls,
  ): Promise<ProjectSnapshot> {
    return this.run(async (signal, progress) => {
      const work = await PackageWork.create(this.store.root, this.recovery);
      try {
        const { snapshot, manifest, original } = await this.prepare(
          projectId,
          work,
          signal,
        );
        await checkSpace(
          work.root,
          manifest.entries.reduce((sum, entry) => sum + entry.size, 0),
        );
        const media = manifest.entries.filter(
          (entry) => entry.path !== 'project.sqlite',
        );
        progress.start(
          media.reduce((sum, entry) => sum + entry.size, 0),
          media.length,
        );
        for (const entry of manifest.entries) {
          signal.throwIfAborted();
          if (entry.path === 'project.sqlite') continue;
          progress.file(entry.path);
          const input = await open(
            await safeFile(original, entry.path),
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const before = await input.stat();
            if (!before.isFile() || before.size !== entry.size)
              throw new Error('项目素材大小已改变');
            const output = await work.createFile(entry.path);
            try {
              signal.throwIfAborted();
              const hash = createHash('sha256');
              let size = 0;
              for await (const chunk of input.createReadStream({
                autoClose: false,
                highWaterMark: 256 * 1024,
              })) {
                signal.throwIfAborted();
                size += (chunk as Buffer).length;
                if (size > entry.size) throw new Error('项目素材正在被修改');
                hash.update(chunk);
                await output.writeFile(chunk);
                progress.written((chunk as Buffer).length);
              }
              if (
                size !== entry.size ||
                (await input.stat()).mtimeMs !== before.mtimeMs ||
                hash.digest('hex') !== entry.sha256
              )
                throw new Error('项目素材正在被修改');
              await output.sync();
              progress.verified();
            } finally {
              await output.close();
            }
          } finally {
            await input.close();
          }
        }
        return await this.commit(
          work,
          name ?? `${snapshot.project.name.slice(0, 97)} 副本`,
          signal,
          progress,
        );
      } finally {
        await work.cleanup();
      }
    }, controls);
  }

  private async prepare(
    projectId: string,
    work: PackageWork,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const source = await this.projects.databasePath(projectId);
    const databaseSize = (await lstat(source)).size;
    if (databaseSize > MAX_DATABASE_BYTES)
      throw new Error('项目数据库体积超出项目包支持范围');
    await checkSpace(work.root, databaseSize * 2);
    const destination = await work.createFile('project.sqlite');
    await destination.close();
    const database = join(work.root, 'project.sqlite');
    await snapshotPackageDatabase(source, database);
    signal.throwIfAborted();
    const { snapshot, entries } = validatePackageDatabase(database);
    if (snapshot.project.id !== projectId)
      throw new Error('项目文件与索引不匹配');
    const dbFingerprint = await fingerprint(database);
    const manifest: PackageManifest = {
      format: 'infinite-afflatus',
      version: 1,
      entries: [
        {
          type: 'file',
          path: 'project.sqlite',
          size: dbFingerprint.size,
          sha256: dbFingerprint.sha256,
        },
        ...entries,
      ],
    };
    validateManifest(manifest);
    return { snapshot, manifest, original: dirname(source) };
  }

  private async commit(
    work: PackageWork,
    name: string,
    signal: AbortSignal,
    progress: PackageProgressReporter,
  ) {
    signal.throwIfAborted();
    progress.update({ phase: 'finalizing', fileName: null });
    const id = randomUUID();
    const project: ProjectSummary = {
      id,
      folder: id,
      name: validateName(name),
      updatedAt: new Date().toISOString(),
    };
    const snapshot = adoptPackageDatabase(
      join(work.root, 'project.sqlite'),
      project,
    );
    if (snapshot.project.id !== id || snapshot.project.folder !== id)
      throw new Error('项目副本标识写入校验失败，未加入项目库');
    await work.createProjectDirectories();
    const handle = await open(
      join(work.root, 'project.sqlite'),
      constants.O_RDWR | constants.O_NOFOLLOW,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await work.sync();
    const target = inside(this.store.root, id);
    await this.requireMissing(target);
    signal.throwIfAborted();
    progress.update({ canCancel: false });
    await rename(work.root, target);
    // The journal deliberately retains the former temporary paths. A crash after this
    // atomic rename leaves a complete discoverable project, never a cleanup target.
    work.release();
    await syncDirectory(this.store.root);
    this.store.putProject(project);
    // Ownership passes to the library only after the durable database and recent index are committed.
    return snapshot;
  }

  private info(snapshot: ProjectSnapshot, bytes: number): ProjectPackageInfo {
    return {
      projectId: snapshot.project.id,
      name: snapshot.project.name,
      assetCount: snapshot.assets.length,
      bytes,
    };
  }

  private async requireMissing(path: string) {
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    throw new Error('目标已存在，请选择新的文件名，避免覆盖已有项目或备份');
  }
}
