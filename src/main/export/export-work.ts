import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppStore } from '../storage/app-store';
import { safeFile } from '../storage/files';

interface WorkFile {
  name: string;
  device: number;
  inode: number;
}

/** Registered file identities survive interruptions; unknown files are never removed. */
export class ExportWork {
  constructor(
    private store: AppStore,
    readonly root: string,
  ) {}

  private records(): WorkFile[] {
    return this.store.get<WorkFile[]>('exportWork') ?? [];
  }

  async create(extension: string): Promise<string> {
    await mkdir(this.root, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink())
      throw new Error('导出暂存目录不能是符号链接');
    const name = `${randomUUID()}.${extension}`;
    const file = join(this.root, name);
    const handle = await open(file, 'wx', 0o600);
    try {
      const stat = await handle.stat();
      this.store.set('exportWork', [
        ...this.records(),
        { name, device: stat.dev, inode: stat.ino },
      ]);
    } finally {
      await handle.close();
    }
    return file;
  }

  async clean(): Promise<void> {
    const kept: WorkFile[] = [];
    for (const record of this.records()) {
      try {
        const file = await safeFile(this.root, record.name);
        const stat = await lstat(file);
        if (stat.dev !== record.device || stat.ino !== record.inode) {
          kept.push(record);
          continue;
        }
        await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          kept.push(record);
      }
    }
    this.store.set('exportWork', kept);
  }
}
