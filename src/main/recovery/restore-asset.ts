import { link, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ProjectHealthProgress } from '../../shared/project-health';
import { verifyProjectDatabase } from '../projects/project-database';
import type { ProjectService } from '../projects/project-service';
import { checkSpace, inside, syncDirectory } from '../storage/files';
import { inspectAsset, validateAsset } from './asset-inspection';
import type { RepairWork } from './repair-work';
import { verifyFile } from './verified-file';

/** Preserve every project record and publish only verified bytes at a missing original path. */
export async function restoreAsset(
  projects: ProjectService,
  work: RepairWork,
  userData: string,
  projectId: string,
  assetId: string,
  source: string,
  signal: AbortSignal,
  onProgress: (state: ProjectHealthProgress) => void,
): Promise<void> {
  const snapshot = await projects.open(projectId);
  const database = await projects.databasePath(projectId);
  verifyProjectDatabase(database);
  const projectRoot = dirname(database);
  const asset = snapshot.assets.find((item) => item.id === assetId);
  if (!asset) throw new Error('素材不存在，请重新检查项目');
  validateAsset(asset);
  const issue = await inspectAsset(
    projectRoot,
    asset,
    'quick',
    signal,
    () => {},
  );
  if (issue?.problem !== 'missing')
    throw new Error('只能恢复缺失素材；已有文件不会被覆盖，请重新检查项目');
  const expected = JSON.stringify(asset);
  const rootIdentity = await lstat(projectRoot);
  const verifyLocation = async () => {
    if ((await projects.databasePath(projectId)) !== database)
      throw new Error('项目位置已变化，请重新检查后恢复');
    const currentRoot = await lstat(projectRoot);
    if (
      currentRoot.dev !== rootIdentity.dev ||
      currentRoot.ino !== rootIdentity.ino
    )
      throw new Error('项目目录已被替换，请重新打开项目');
    const current = await projects.open(projectId);
    if (
      JSON.stringify(current.assets.find((item) => item.id === assetId)) !==
      expected
    )
      throw new Error('素材记录已变化，请重新检查后恢复');
  };
  const staging = join(userData, 'asset-recovery');
  await mkdir(staging, { recursive: true });
  if (
    (await lstat(staging)).isSymbolicLink() ||
    (await realpath(staging)) !== resolve(staging)
  )
    throw new Error('素材恢复暂存目录无效');
  await checkSpace(staging, asset.size);
  const copy = await work.create(staging);
  let sibling: Awaited<ReturnType<RepairWork['create']>> | undefined;
  const progress = (value: number) =>
    onProgress({
      projectId,
      operation: 'restore',
      progress: value,
      assetName: asset.name,
    });
  progress(0);
  try {
    try {
      const checked = await verifyFile(
        source,
        asset.size,
        signal,
        (bytes) => progress((0.45 * bytes) / Math.max(1, asset.size)),
        copy.handle,
      );
      if (checked.size !== asset.size || checked.sha256 !== asset.sha256)
        throw new Error('所选文件与原素材内容不一致，请选择完全相同的原文件');
    } finally {
      await copy.handle.close();
    }
    signal.throwIfAborted();
    // The gate prevents application migration; identity checks also catch external moves.
    await verifyLocation();
    const target = inside(projectRoot, asset.relativePath);
    await prepareParent(projectRoot, dirname(target), signal);
    await requireMissing(target);
    await checkSpace(dirname(target), asset.size);
    sibling = await work.create(dirname(target));
    try {
      const checked = await verifyFile(
        await work.validate(copy.id),
        asset.size,
        signal,
        (bytes) => progress(0.45 + (0.5 * bytes) / Math.max(1, asset.size)),
        sibling.handle,
      );
      if (checked.size !== asset.size || checked.sha256 !== asset.sha256)
        throw new Error('恢复暂存文件校验失败，未修改原位置');
    } finally {
      await sibling.handle.close();
    }
    signal.throwIfAborted();
    await verifyLocation();
    await prepareParent(projectRoot, dirname(target), signal);
    const verified = await work.validate(sibling.id);
    await requireMissing(target);
    signal.throwIfAborted();
    // No fallback to non-atomic copying: a crash must never expose a partial registered asset.
    try {
      await link(verified, target);
    } catch (error) {
      if (
        ['ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw new Error(
          '该磁盘不支持自动恢复。请关闭应用，将原文件复制到提示的项目内位置，再重新打开并完整校验内容',
        );
      throw error;
    }
    await syncDirectory(dirname(target));
    // Publication is the commit point. Cancellation after it must not undo good data.
    progress(1);
  } finally {
    await work.clean(copy.id);
    if (sibling) await work.clean(sibling.id);
  }
}

async function requireMissing(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error('原位置已有文件，恢复已停止且不会覆盖它，请重新检查项目');
}

async function prepareParent(
  root: string,
  parent: string,
  signal: AbortSignal,
) {
  if (
    (await lstat(root)).isSymbolicLink() ||
    (await realpath(root)) !== resolve(root)
  )
    throw new Error('项目目录包含符号链接');
  let cursor = root;
  for (const part of relative(root, parent).split(sep)) {
    signal.throwIfAborted();
    cursor = inside(cursor, part);
    try {
      await mkdir(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('素材目录包含链接或不是文件夹');
    await syncDirectory(dirname(cursor));
  }
}
