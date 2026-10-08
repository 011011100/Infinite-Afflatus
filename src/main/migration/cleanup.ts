import { rmdir, unlink } from 'node:fs/promises';
import { readProject, readProxies } from '../projects/project-database';
import { errorMessage } from '../storage/database';
import {
  fingerprint,
  inside,
  safeFile,
  sameContent,
  sameFile,
} from '../storage/files';
import {
  directoryIdentity,
  type MigrationJournal,
  sameDirectory,
} from './manifest';

/** Delete only receipts whose identities/content still match; never recursively remove a library. */
export async function cleanupMigration(
  journal: MigrationJournal,
  persist: () => void,
): Promise<void> {
  const { source, target } = journal.status;
  if (
    !sameDirectory(await directoryIdentity(source), journal.sourceIdentity) ||
    !sameDirectory(await directoryIdentity(target), journal.targetIdentity)
  ) {
    throw new Error('迁移目录已被替换，自动清理已停止');
  }
  const deletingRoot = journal.switched ? source : target;
  const directories = journal.switched
    ? journal.sourceDirectories
    : journal.targetDirectories;
  // Assets before databases. Target project databases can legitimately change after a completed move.
  const ordered = [...journal.files].sort(
    (a, b) =>
      Number(a.relativePath.endsWith('/project.sqlite')) -
      Number(b.relativePath.endsWith('/project.sqlite')),
  );
  for (const entry of ordered) {
    if (entry.cleaned || !entry.copied) continue;
    try {
      const deleting = await safeFile(deletingRoot, entry.relativePath);
      for (const [parent, identity] of Object.entries(directories)) {
        if (
          entry.relativePath.startsWith(`${parent}/`) &&
          !sameDirectory(
            await directoryIdentity(inside(deletingRoot, parent)),
            identity,
          )
        )
          throw new Error('文件所属目录已被替换');
      }
      const expected = journal.switched ? entry.source : entry.copied;
      if (!sameFile(await fingerprint(deleting), expected)) {
        journal.status.warnings.push(`文件已变化，保留：${entry.relativePath}`);
        entry.cleaned = true;
        persist();
        continue;
      }
      if (journal.switched) {
        const destination = await safeFile(target, entry.relativePath);
        if (entry.relativePath.endsWith('/project.sqlite')) {
          const targetProject = readProject(destination);
          if (targetProject.project.id !== entry.projectId)
            throw new Error('目标项目身份不匹配');
          const sourceProject = readProject(deleting);
          const sourceProxies = readProxies(deleting);
          const targetProxies = readProxies(destination);
          // Classify from the unchanged source database, never by a filename or
          // the current target alone. A proxy record cannot replace an original asset.
          for (const asset of journal.files.filter(
            (item) =>
              item.projectId === entry.projectId &&
              !item.relativePath.endsWith('/project.sqlite'),
          )) {
            const original = sourceProject.assets.find(
              (record) =>
                `${sourceProject.project.folder}/${record.relativePath}` ===
                  asset.relativePath && sameContent(asset.source, record),
            );
            if (original) {
              if (
                !targetProject.assets.some(
                  (record) =>
                    record.id === original.id &&
                    `${targetProject.project.folder}/${record.relativePath}` ===
                      asset.relativePath &&
                    sameContent(asset.source, record),
                )
              )
                throw new Error('目标项目缺少原素材记录');
            } else {
              const proxy = sourceProxies.find(
                (record) =>
                  `${sourceProject.project.folder}/${record.relativePath}` ===
                    asset.relativePath && sameContent(record, asset.source),
              );
              if (
                !proxy ||
                !targetProxies.some(
                  (record) =>
                    record.relativePath === proxy.relativePath &&
                    record.assetId === proxy.assetId &&
                    record.sourceHash === proxy.sourceHash &&
                    record.version === proxy.version &&
                    sameContent(record, asset.source),
                )
              )
                throw new Error('目标项目缺少对应的派生预览记录');
            }
            if (
              !sameContent(
                await fingerprint(await safeFile(target, asset.relativePath)),
                asset.source,
              )
            )
              throw new Error('目标素材校验失败');
          }
        } else if (!sameContent(await fingerprint(destination), entry.source))
          throw new Error('目标文件校验失败');
      }
      // Recheck parents immediately before unlink; external replacements never grant new ownership.
      await safeFile(deletingRoot, entry.relativePath);
      if (!sameFile(await fingerprint(deleting), expected))
        throw new Error('文件在清理时发生变化');
      await unlink(deleting);
      entry.cleaned = true;
      persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // A missing source can be treated as cleaned only when that source itself is absent.
        try {
          await safeFile(deletingRoot, entry.relativePath);
        } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === 'ENOENT') {
            entry.cleaned = true;
            persist();
            continue;
          }
        }
      }
      throw new Error(`无法清理 ${entry.relativePath}：${errorMessage(error)}`);
    }
  }
  for (const [relativePath, identity] of Object.entries(directories).sort(
    ([a], [b]) => b.length - a.length,
  )) {
    try {
      const path = inside(deletingRoot, relativePath);
      for (const [parent, parentIdentity] of Object.entries(directories)) {
        if (
          relativePath.startsWith(`${parent}/`) &&
          !sameDirectory(
            await directoryIdentity(inside(deletingRoot, parent)),
            parentIdentity,
          )
        )
          throw new Error('清理目录的上级路径已变化');
      }
      if (sameDirectory(await directoryIdentity(path), identity))
        await rmdir(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST')
        throw error;
    }
  }
}
