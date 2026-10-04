import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ProxyResult } from '../../shared/desktop';
import { readProxies, recordProxy } from '../projects/project-database';
import type { ProjectService } from '../projects/project-service';
import type { AppStore } from '../storage/app-store';
import {
  checkSpace,
  fingerprint,
  localFileStream,
  publishCopy,
  safeFile,
  sameContent,
} from '../storage/files';
import type { WriteGate } from '../storage/write-gate';
import { ProxyWork } from './proxy-work';
import {
  MAX_PROXY_BYTES,
  PROXY_VERSION,
  transcodeProxy,
} from './transcode-proxy';

/** One background encoder. Generation and publication have separate migration lifetimes. */
export class ProxyService {
  private work: ProxyWork;
  private abort = new AbortController();
  private tail: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Promise<ProxyResult>>();

  constructor(
    private projects: ProjectService,
    private gate: WriteGate,
    store: AppStore,
    private userData: string,
    private encode = transcodeProxy,
  ) {
    this.work = new ProxyWork(store, join(userData, 'preview-work'));
  }

  recover(): Promise<void> {
    return this.work.clean();
  }

  async file(projectId: string, assetId: string): Promise<string | null> {
    const snapshot = await this.projects.open(projectId);
    const asset = snapshot.assets.find(
      (item) => item.id === assetId && item.kind === 'video',
    );
    if (!asset) return null;
    const database = await this.projects.databasePath(projectId);
    const records = readProxies(
      database,
      this.projects.summary(projectId),
    ).filter(
      (item) =>
        item.assetId === assetId &&
        item.sourceHash === asset.sha256 &&
        item.version === PROXY_VERSION,
    );
    for (const record of records.reverse()) {
      try {
        const file = await safeFile(dirname(database), record.relativePath);
        if ((await lstat(file)).size === record.size) return file;
      } catch {
        /* A missing derived file can be rebuilt. */
      }
    }
    return null;
  }

  ensure(projectId: string, assetId: string): Promise<ProxyResult> {
    const key = `${projectId}:${assetId}`;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = this.tail
      .then(async (): Promise<ProxyResult> => {
        try {
          this.abort.signal.throwIfAborted();
          if (
            await this.gate.whenOpen(
              () => this.file(projectId, assetId),
              this.abort.signal,
            )
          )
            return { ready: true };
          await this.generate(projectId, assetId);
          return { ready: true };
        } catch (error) {
          if (!this.abort.signal.aborted)
            console.warn('Preview proxy unavailable:', error);
          return { ready: false };
        }
      })
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, task);
    this.tail = task;
    return task;
  }

  private async generate(projectId: string, assetId: string): Promise<void> {
    const signal = this.abort.signal;
    const temporary: string[] = [];
    try {
      const input = await this.work.create('source');
      temporary.push(input);
      const output = await this.work.create('mp4');
      temporary.push(output);
      // Only this short copy holds project admission. FFmpeg reads the independent copy.
      const source = await this.gate.whenOpen(async () => {
        signal.throwIfAborted();
        const snapshot = await this.projects.open(projectId);
        const asset = snapshot.assets.find(
          (item) => item.id === assetId && item.kind === 'video',
        );
        if (!asset) throw new Error('视频不存在');
        const root = dirname(await this.projects.databasePath(projectId));
        await checkSpace(this.userData, asset.size + MAX_PROXY_BYTES);
        await pipeline(
          await localFileStream(await safeFile(root, asset.relativePath)),
          createWriteStream(input, { flags: 'r+' }),
          { signal },
        );
        if (!sameContent(await fingerprint(input), asset))
          throw new Error('素材内容已经变化');
        return asset;
      }, signal);
      await this.encode(input, output, signal);
      const generated = await fingerprint(output);
      if (!generated.size || generated.size > MAX_PROXY_BYTES)
        throw new Error('预览文件超出大小限制');
      await this.gate.whenOpen(async () => {
        signal.throwIfAborted();
        const current = await this.projects.open(projectId);
        if (
          !current.assets.some(
            (asset) => asset.id === source.id && asset.sha256 === source.sha256,
          )
        )
          throw new Error('视频素材已经变化，预览文件未保存');
        const database = await this.projects.databasePath(projectId);
        const root = dirname(database);
        const relativePath = `cache/proxy-v${PROXY_VERSION}-${randomUUID()}.mp4`;
        const cache = join(root, 'cache');
        // Existing project folders have cache/. Never follow a user-supplied replacement link.
        if (
          !(await lstat(cache)).isDirectory() ||
          (await lstat(cache)).isSymbolicLink()
        )
          throw new Error('项目缓存目录不可用');
        await checkSpace(root, generated.size);
        await publishCopy(output, join(root, relativePath));
        const copied = await fingerprint(await safeFile(root, relativePath));
        if (!sameContent(copied, generated))
          throw new Error('预览保存校验失败');
        recordProxy(
          database,
          {
            ...copied,
            assetId,
            sourceHash: source.sha256,
            version: PROXY_VERSION,
            relativePath,
          },
          this.projects.summary(projectId),
        );
      }, signal);
    } finally {
      await this.work.clean(temporary);
    }
  }

  async close(): Promise<void> {
    this.abort.abort();
    await this.tail;
  }
}
