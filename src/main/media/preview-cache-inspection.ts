import { lstatSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  Asset,
  ProjectSnapshot,
  ProjectSummary,
} from '../../shared/models';
import type { PreviewCacheItem } from '../../shared/preview-cache';
import type { MigrationJournal } from '../migration/manifest';
import { readProject, readProxies } from '../projects/project-database';
import { isId, type ProjectService } from '../projects/project-service';
import type { AppStore } from '../storage/app-store';
import { errorMessage } from '../storage/database';
import { inside, sameContent, sameFile } from '../storage/files';
import {
  type PathFacts,
  pathFacts,
  unchangedPath,
  type VerifiedFile,
  verifiedFile,
} from './preview-cache-safety';
import type { ProxyRecord } from './proxy-record';
import type { ProxyService } from './proxy-service';

type ProjectContext = {
  root: string;
  database: PathFacts;
  summary: ProjectSummary;
  snapshot: ProjectSnapshot;
  records: ProxyRecord[];
  metadata: string;
};
export interface CacheCandidate {
  item: PreviewCacheItem;
  context: ProjectContext;
  record: ProxyRecord;
  source: Asset;
  original: VerifiedFile;
  proxy: VerifiedFile;
  registeredOriginals: { relativePath: string; path: PathFacts }[];
}
export interface CacheScan {
  items: PreviewCacheItem[];
  candidates: CacheCandidate[];
  incomplete: boolean;
}

function validRecord(record: ProxyRecord): boolean {
  if (!record || typeof record !== 'object') return false;
  const match = /^cache\/proxy-v([1-9]\d*)-([a-f0-9-]+)\.mp4$/.exec(
    record.relativePath,
  );
  return !!(
    match &&
    isId(match[2]) &&
    Number(match[1]) === record.version &&
    Number.isSafeInteger(record.version) &&
    isId(record.assetId) &&
    /^[a-f0-9]{64}$/.test(record.sourceHash) &&
    /^[a-f0-9]{64}$/.test(record.sha256) &&
    Number.isSafeInteger(record.size) &&
    record.size > 0 &&
    Number.isSafeInteger(record.device) &&
    Number.isSafeInteger(record.inode) &&
    Number.isFinite(record.modified)
  );
}

/** Read-only scanning and the same conservative validation used at confirmation time. */
export class PreviewCacheInspectionService {
  constructor(
    private projects: ProjectService,
    private store: AppStore,
    private proxies: ProxyService,
    private available: () => void,
  ) {}

  private context(projectId: string): ProjectContext {
    const root = this.store.root;
    const summary = this.projects.summary(projectId);
    if (!isId(summary.id) || summary.folder !== summary.id)
      throw new Error('项目目录与索引不符，已保留');
    const database = pathFacts(root, `${summary.folder}/project.sqlite`);
    if (database.facts.links !== 1)
      throw new Error('项目数据库有多个硬链接，已保留');
    const snapshot = readProject(database.file, summary);
    const records = readProxies(database.file, summary);
    if (!Array.isArray(records)) throw new Error('预览登记信息无效，已保留');
    unchangedPath(root, `${summary.folder}/project.sqlite`, database);
    return {
      root,
      database,
      summary,
      snapshot,
      records,
      metadata: JSON.stringify({
        summary,
        project: snapshot.project,
        assets: snapshot.assets,
        records,
      }),
    };
  }

  async scan(signal: AbortSignal): Promise<CacheScan> {
    const items: PreviewCacheItem[] = [];
    const candidates: CacheCandidate[] = [];
    for (const summary of this.store.projects()) {
      this.available();
      signal.throwIfAborted();
      const item = (relativePath: string): PreviewCacheItem => ({
        projectId: summary.id,
        projectName: summary.name,
        relativePath,
        assetId: null,
        kind: 'unknown',
        bytes: null,
        canCleanup: false,
        reason: '未登记的文件或目录，已保留',
      });
      let context: ProjectContext | null = null;
      let contextError = '';
      try {
        context = this.context(summary.id);
      } catch (error) {
        contextError = errorMessage(error);
      }
      try {
        // Check the indexed project path even when the database is damaged.
        if (!isId(summary.id) || summary.folder !== summary.id)
          throw new Error('项目目录与索引不符，已保留');
        const root = this.store.root;
        const project = join(root, summary.folder);
        const cache = join(project, 'cache');
        for (const directory of [root, project, cache]) {
          const info = lstatSync(directory);
          if (
            !info.isDirectory() ||
            info.isSymbolicLink() ||
            realpathSync(directory) !== resolve(directory)
          )
            throw new Error('缓存目录不可用或含符号链接，已保留');
        }
        const cacheBefore = lstatSync(cache);
        const names = await readdir(cache);
        if (
          lstatSync(cache).ino !== cacheBefore.ino ||
          lstatSync(cache).dev !== cacheBefore.dev
        )
          throw new Error('缓存目录在检查期间已变化，已保留');
        for (const name of names.sort()) {
          this.available();
          signal.throwIfAborted();
          const description = item(`cache/${name}`);
          const matches =
            context?.records.filter(
              (record) => record?.relativePath === description.relativePath,
            ) ?? [];
          if (matches.length) {
            description.kind = 'proxy';
            description.assetId =
              typeof matches[0]?.assetId === 'string'
                ? matches[0].assetId
                : null;
          }
          try {
            description.bytes = pathFacts(
              root,
              `${summary.folder}/${description.relativePath}`,
            ).facts.size;
            if (!context) throw new Error(contextError);
            const record = matches[0];
            if (!record || matches.length !== 1)
              throw new Error(
                matches.length
                  ? '预览登记有重复或冲突，已保留'
                  : description.reason,
              );
            const candidate = await this.candidate(
              context,
              record,
              description,
              signal,
            );
            description.canCleanup = true;
            description.reason = '已验证的派生预览，原素材完整，可按需重建';
            candidates.push(candidate);
          } catch (error) {
            signal.throwIfAborted();
            description.reason = errorMessage(error);
          }
          items.push(description);
        }
        // Invalid registered paths are reported, but are never visited or measured.
        for (const record of context?.records ?? []) {
          if (
            !validRecord(record) &&
            !items.some(
              (entry) =>
                entry.projectId === summary.id &&
                entry.relativePath === record?.relativePath,
            )
          ) {
            const description = item(
              typeof record?.relativePath === 'string'
                ? record.relativePath
                : 'cache/（无效登记）',
            );
            description.kind = 'proxy';
            description.reason = '预览登记路径或身份信息无效，未访问或清理';
            items.push(description);
          }
        }
      } catch (error) {
        signal.throwIfAborted();
        items.push({ ...item('cache/'), reason: errorMessage(error) });
      }
    }
    return {
      items,
      candidates,
      incomplete: items.some((item) => item.bytes === null),
    };
  }

  private async candidate(
    context: ProjectContext,
    record: ProxyRecord,
    item: PreviewCacheItem,
    signal: AbortSignal,
  ): Promise<CacheCandidate> {
    this.available();
    if (!validRecord(record))
      throw new Error('预览登记路径或身份信息无效，已保留');
    const busy = this.proxies.busyReason(item.projectId, record.assetId);
    if (busy) throw new Error(busy);
    const source = context.snapshot.assets.find(
      (asset) => asset.id === record.assetId,
    );
    if (source?.kind !== 'video' || source.sha256 !== record.sourceHash)
      throw new Error('原素材不存在或已变化，保留预览以便恢复');
    if (
      context.snapshot.assets.some(
        (asset) => asset.relativePath === record.relativePath,
      )
    )
      throw new Error('此路径被登记为原素材，已保留');
    const original = await verifiedFile(
      context.root,
      `${context.summary.folder}/${source.relativePath}`,
      signal,
    );
    if (!sameContent(original.content, source))
      throw new Error('原素材内容校验失败，保留预览以便恢复');
    const proxy = await verifiedFile(
      context.root,
      `${context.summary.folder}/${record.relativePath}`,
      signal,
    );
    if (!sameContent(proxy.content, record))
      throw new Error('预览内容与登记不符，已保留');
    if (
      !sameFile(proxy.content, record) &&
      !this.migrated(context, record, proxy)
    )
      throw new Error('预览文件身份与创建或迁移记录不符，已保留');
    if (
      original.facts.device === proxy.facts.device &&
      original.facts.inode === proxy.facts.inode
    )
      throw new Error('预览与原素材指向同一文件，已保留');
    // A database asset can use a dot/case alias of this cache path with nlink=1.
    // Check every original by resolved identity, never just the spelling of its path.
    const registeredOriginals = context.snapshot.assets.map((asset) => {
      if (!asset || typeof asset.relativePath !== 'string')
        throw new Error('原素材登记路径无效，已保留');
      inside(dirname(context.database.file), asset.relativePath);
      const path = pathFacts(
        context.root,
        `${context.summary.folder}/${asset.relativePath}`,
      );
      if (
        path.facts.device === proxy.facts.device &&
        path.facts.inode === proxy.facts.inode
      )
        throw new Error('预览文件也是登记的原素材，已保留');
      return { relativePath: asset.relativePath, path };
    });
    const candidate = {
      item,
      context,
      record,
      source,
      original,
      proxy,
      registeredOriginals,
    };
    this.checkCurrent(candidate, signal);
    return candidate;
  }

  private migrated(
    context: ProjectContext,
    record: ProxyRecord,
    proxy: VerifiedFile,
  ): boolean {
    const journal = this.store.get<MigrationJournal>('migration');
    return !!(
      journal?.switched &&
      journal.status.target === context.root &&
      journal.files.some(
        (file) =>
          file.projectId === context.summary.id &&
          file.relativePath ===
            `${context.summary.folder}/${record.relativePath}` &&
          file.copied &&
          sameContent(file.source, record) &&
          sameFile(file.copied, proxy.content),
      )
    );
  }

  /** Rehash both files and require the exact previewed metadata, paths and identities. */
  async revalidate(
    expected: CacheCandidate,
    signal: AbortSignal,
  ): Promise<CacheCandidate> {
    this.checkCurrent(expected, signal);
    const current = await this.candidate(
      this.context(expected.item.projectId),
      expected.record,
      expected.item,
      signal,
    );
    if (
      JSON.stringify(current.original) !== JSON.stringify(expected.original) ||
      JSON.stringify(current.proxy) !== JSON.stringify(expected.proxy)
    )
      throw new Error('确认后原素材或预览文件已变化，已保留');
    this.checkCurrent(expected, signal);
    return expected;
  }

  /** Called immediately before a synchronous unlink, without an await in between. */
  checkCurrent(candidate: CacheCandidate, signal: AbortSignal): void {
    signal.throwIfAborted();
    this.available();
    const busy = this.proxies.busyReason(
      candidate.item.projectId,
      candidate.record.assetId,
    );
    if (busy) throw new Error(busy);
    const context = this.context(candidate.item.projectId);
    if (
      context.root !== candidate.context.root ||
      context.metadata !== candidate.context.metadata
    )
      throw new Error('目录、项目或预览登记信息已变化，请重新检查');
    unchangedPath(
      context.root,
      `${context.summary.folder}/project.sqlite`,
      candidate.context.database,
    );
    unchangedPath(
      context.root,
      `${context.summary.folder}/${candidate.source.relativePath}`,
      candidate.original,
    );
    unchangedPath(
      context.root,
      `${context.summary.folder}/${candidate.record.relativePath}`,
      candidate.proxy,
    );
    for (const original of candidate.registeredOriginals) {
      unchangedPath(
        context.root,
        `${context.summary.folder}/${original.relativePath}`,
        original.path,
      );
      if (
        original.path.facts.device === candidate.proxy.facts.device &&
        original.path.facts.inode === candidate.proxy.facts.inode
      )
        throw new Error('预览文件也是登记的原素材，已保留');
    }
  }
}
