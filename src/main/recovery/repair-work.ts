import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AppStore } from '../storage/app-store';
import { safeFile } from '../storage/files';

const WORK_KEY = 'asset-repair-work';
interface Identity {
  dev: number;
  ino: number;
}
interface WorkRecord extends Identity {
  id: string;
  name: string;
  parent: Identity & { path: string };
}

/** Only exclusively created temporary files are registered; restored asset paths never are. */
export class RepairWork {
  constructor(private readonly store: AppStore) {}
  private records() {
    return this.store.get<WorkRecord[]>(WORK_KEY) ?? [];
  }
  async validate(id: string) {
    const record = this.records().find((item) => item.id === id);
    if (!record) throw new Error('恢复暂存记录丢失，未修改原位置');
    const parent = await lstat(record.parent.path);
    const file = await safeFile(record.parent.path, record.name);
    const current = await lstat(file);
    if (
      parent.dev !== record.parent.dev ||
      parent.ino !== record.parent.ino ||
      current.dev !== record.dev ||
      current.ino !== record.ino
    )
      throw new Error('恢复暂存文件或目录已变化，未修改原位置');
    return file;
  }
  async create(parent: string) {
    const directory = await lstat(parent);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (await realpath(parent)) !== resolve(parent)
    )
      throw new Error('素材恢复目录无效');
    const id = randomUUID();
    const name = `.afflatus-restore-${id}.part`;
    const path = join(parent, name);
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const identity = await handle.stat();
      this.store.set(WORK_KEY, [
        ...this.records(),
        {
          id,
          name,
          dev: identity.dev,
          ino: identity.ino,
          parent: { path: parent, dev: directory.dev, ino: directory.ino },
        },
      ]);
      return { id, path, handle };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async clean(id?: string) {
    const retained: WorkRecord[] = [];
    for (const record of this.records()) {
      if (id && record.id !== id) {
        retained.push(record);
        continue;
      }
      try {
        const parent = await lstat(record.parent.path);
        if (
          parent.isSymbolicLink() ||
          !parent.isDirectory() ||
          parent.dev !== record.parent.dev ||
          parent.ino !== record.parent.ino ||
          (await realpath(record.parent.path)) !== resolve(record.parent.path)
        ) {
          retained.push(record);
          continue;
        }
        try {
          const file = await safeFile(record.parent.path, record.name);
          const current = await lstat(file);
          if (current.dev !== record.dev || current.ino !== record.ino) {
            retained.push(record);
            continue;
          }
          await unlink(file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      } catch {
        // An offline/replaced volume keeps its ownership journal for a later retry.
        retained.push(record);
      }
    }
    this.store.set(WORK_KEY, retained);
  }
}
