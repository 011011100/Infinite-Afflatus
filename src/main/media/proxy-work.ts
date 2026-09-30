import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppStore } from '../storage/app-store';
import { safeFile } from '../storage/files';

type WorkFile = { name: string; device: number; inode: number };

/** Only registered file identities are cleaned, including recovery after interruption. */
export class ProxyWork {
  constructor(
    private store: AppStore,
    private root: string,
  ) {}

  async create(extension: string): Promise<string> {
    await mkdir(this.root, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink())
      throw new Error('预览暂存目录不能是符号链接');
    const name = `${randomUUID()}.${extension}`;
    const file = join(this.root, name);
    const handle = await open(file, 'wx', 0o600);
    try {
      const stat = await handle.stat();
      this.store.set('proxyWork', [
        ...this.records(),
        { name, device: stat.dev, inode: stat.ino },
      ]);
    } finally {
      await handle.close();
    }
    return file;
  }

  records(): WorkFile[] {
    return this.store.get<WorkFile[]>('proxyWork') ?? [];
  }

  async clean(paths?: string[]): Promise<void> {
    const kept: WorkFile[] = [];
    for (const record of this.records()) {
      if (paths && !paths.includes(join(this.root, record.name))) {
        kept.push(record);
        continue;
      }
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
    this.store.set('proxyWork', kept);
  }
}
