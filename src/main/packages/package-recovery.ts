import { lstat, realpath, rmdir, unlink } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { AppStore } from '../storage/app-store';
import { safeFile } from '../storage/files';

export const PACKAGE_WORK_KEY = 'project-package-work';
export interface PackageIdentity {
  path: string;
  dev: number;
  ino: number;
}
export interface PackageWorkRecord {
  id: string;
  parent: PackageIdentity;
  root: PackageIdentity;
  directories: PackageIdentity[];
  files: Array<PackageIdentity & { externalParent?: PackageIdentity }>;
}

async function matches(entry: PackageIdentity, directory: boolean) {
  const stat = await lstat(entry.path);
  return (
    !stat.isSymbolicLink() &&
    stat.dev === entry.dev &&
    stat.ino === entry.ino &&
    (directory ? stat.isDirectory() : stat.isFile()) &&
    (await realpath(entry.path)) === resolve(entry.path)
  );
}

/** Durable ownership only: no directory traversal or recursive deletion during crash recovery. */
export class PackageRecovery {
  constructor(private readonly store: AppStore) {}
  records() {
    return this.store.get<PackageWorkRecord[]>(PACKAGE_WORK_KEY) ?? [];
  }
  put(record: PackageWorkRecord) {
    this.store.set(PACKAGE_WORK_KEY, [
      ...this.records().filter((item) => item.id !== record.id),
      record,
    ]);
  }
  forget(id: string) {
    this.store.set(
      PACKAGE_WORK_KEY,
      this.records().filter((item) => item.id !== id),
    );
  }

  async clean(id?: string) {
    for (const original of this.records()) {
      if (id && original.id !== id) continue;
      const record = structuredClone(original);
      let rootAvailable = false;
      let rootGone = false;
      try {
        rootAvailable = await matches(record.root, true);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // An unavailable volume retains its journal. A removed temporary directory on an
          // available parent has already been cleaned or atomically adopted as a project.
          rootGone = await matches(record.parent, true).catch(() => false);
        }
      }
      const files: PackageWorkRecord['files'] = [];
      for (const file of record.files) {
        if (!file.externalParent && rootGone) continue;
        const anchor = file.externalParent ?? record.root;
        const anchorAvailable = file.externalParent
          ? await matches(anchor, true).catch(() => false)
          : rootAvailable;
        if (!anchorAvailable) {
          files.push(file);
          continue;
        }
        try {
          await safeFile(anchor.path, relative(anchor.path, file.path));
          if (!(await matches(file, false))) {
            files.push(file);
            continue;
          }
          await unlink(file.path);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
            !(await matches(anchor, true).catch(() => false))
          )
            files.push(file);
        }
      }
      const directories: PackageIdentity[] = [];
      if (!rootGone) {
        for (const directory of [...record.directories].reverse()) {
          try {
            if (!rootAvailable || !(await matches(directory, true))) {
              directories.unshift(directory);
              continue;
            }
            await rmdir(directory.path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
              directories.unshift(directory);
          }
        }
      }
      if (files.length || directories.length)
        this.put({ ...record, files, directories });
      else this.forget(record.id);
    }
  }
}
