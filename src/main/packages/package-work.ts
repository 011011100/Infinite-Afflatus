import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inside, syncDirectory } from '../storage/files';
import { validatePackagePath } from './package-format';
import type { PackageIdentity, PackageRecovery } from './package-recovery';

type Identity = { dev: number; ino: number };

/** Cleanup touches only files this operation exclusively created, never user-added contents. */
export class PackageWork {
  private readonly id = randomUUID();
  private files = new Map<
    string,
    Identity & { externalParent?: PackageIdentity }
  >();
  private directories = new Map<string, Identity>();
  private released = false;
  private constructor(
    public root: string,
    private readonly identity: Identity,
    private readonly parent: PackageIdentity,
    private readonly recovery?: PackageRecovery,
  ) {
    this.directories.set(root, identity);
    this.persist();
  }

  static async create(parent: string, recovery?: PackageRecovery) {
    const parentStat = await lstat(parent);
    const parentIdentity = {
      path: parent,
      dev: parentStat.dev,
      ino: parentStat.ino,
    };
    const root = await mkdtemp(join(parent, '.afflatus-package-'));
    return new PackageWork(root, await lstat(root), parentIdentity, recovery);
  }

  async createFile(relativePath: string) {
    validatePackagePath(relativePath);
    const file = inside(this.root, relativePath);
    const directory = dirname(file);
    if (directory !== this.root) {
      for (const part of [
        'assets',
        relativePath.split('/').slice(0, 2).join('/'),
      ]) {
        await this.createDirectory(part);
      }
    }
    const handle = await open(
      file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    this.files.set(file, await handle.stat());
    try {
      this.persist();
    } catch (error) {
      await handle.close();
      throw error;
    }
    return handle;
  }

  async registerExternal(path: string, identity: Identity) {
    const parent = dirname(path);
    const parentStat = await lstat(parent);
    this.files.set(path, {
      ...identity,
      externalParent: {
        path: parent,
        dev: parentStat.dev,
        ino: parentStat.ino,
      },
    });
    this.persist();
  }

  /** Cache bytes are excluded from archives, but the adopted project still needs its working directories. */
  async createProjectDirectories() {
    for (const directory of [
      'assets',
      'assets/videos',
      'assets/images',
      'assets/audio',
      'assets/text',
      'cache',
    ])
      await this.createDirectory(directory);
  }

  private async createDirectory(relativePath: string) {
    const path = inside(this.root, relativePath);
    if (!this.directories.has(path)) {
      await mkdir(path);
      this.directories.set(path, await lstat(path));
      this.persist();
    }
    const current = await lstat(path);
    if (!current.isDirectory() || current.isSymbolicLink())
      throw new Error('项目包工作目录无效');
  }

  async sync() {
    for (const directory of [...this.directories.keys()].reverse())
      await syncDirectory(directory);
  }

  private persist() {
    this.recovery?.put({
      id: this.id,
      parent: this.parent,
      root: { path: this.root, dev: this.identity.dev, ino: this.identity.ino },
      directories: [...this.directories].map(([path, identity]) => ({
        path,
        dev: identity.dev,
        ino: identity.ino,
      })),
      files: [...this.files].map(([path, identity]) => ({
        path,
        dev: identity.dev,
        ino: identity.ino,
        ...(identity.externalParent
          ? { externalParent: identity.externalParent }
          : {}),
      })),
    });
  }

  release() {
    this.released = true;
    this.recovery?.forget(this.id);
  }

  async cleanup() {
    if (this.released) return;
    if (this.recovery) {
      await this.recovery.clean(this.id);
      if (this.recovery.records().some((record) => record.id === this.id))
        throw new Error(
          '项目包临时文件尚未清理完毕，已保留清理记录；请确认磁盘可用后重新打开应用',
        );
      return;
    }
    const root = await lstat(this.root).catch(() => null);
    if (
      !root?.isDirectory() ||
      root.isSymbolicLink() ||
      root.dev !== this.identity.dev ||
      root.ino !== this.identity.ino
    )
      return;
    for (const [file, identity] of this.files) {
      const current = await lstat(file).catch(() => null);
      if (
        current?.isFile() &&
        !current.isSymbolicLink() &&
        current.dev === identity.dev &&
        current.ino === identity.ino
      )
        await unlink(file).catch(() => undefined);
    }
    for (const directory of [...this.directories.keys()].reverse())
      await rmdir(directory).catch(() => undefined);
  }
}
