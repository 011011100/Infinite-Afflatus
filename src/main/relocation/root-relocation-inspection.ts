import { isAbsolute, join, resolve } from 'node:path';
import type { SaveJob } from '../../shared/models';
import { readAnchor, sameAnchor } from '../backups/backup-anchor';
import {
  directoryIdentity,
  info,
  RESTORE_FILE,
  sameIdentity,
  verifyDirectory,
} from '../backups/backup-files';
import { verifyProjectDatabase } from '../projects/project-database';
import { overlaps } from '../storage/files';
import {
  projectsIn,
  readApplication,
  requireStableApplication,
} from './relocation-database';
import {
  requireDatabase,
  requireIndependentDatabase,
  same,
} from './relocation-files';
import {
  type ProjectEvidence,
  RELOCATION_FILE,
  type RelocationInspection,
} from './root-relocation-types';

export async function requireMissingRoot(root: string) {
  if (await info(root)) throw new Error('原保存位置仍存在，不能重新定位原目录');
}
export async function requireNoRestore(userData: string) {
  if (await info(join(userData, RESTORE_FILE)))
    throw new Error('应用索引恢复尚未结束，请先完成原恢复');
}
export async function inspectApplication(
  userData: string,
  signal?: AbortSignal,
) {
  await directoryIdentity(userData);
  await requireNoRestore(userData);
  if (await info(join(userData, RELOCATION_FILE)))
    throw new Error('目录重定位尚未收尾，请重新启动以续接');
  const anchor = await readAnchor(userData);
  await requireMissingRoot(anchor.root.path);
  const application = await readApplication(
    join(userData, 'app.sqlite'),
    signal,
  );
  requireStableApplication(application.data, anchor);
  if (!sameAnchor(anchor, await readAnchor(userData)))
    throw new Error('应用目录代际在检查期间变化');
  return { anchor, ...application };
}
export async function inspectProjects(
  root: string,
  projects: ReturnType<typeof projectsIn>,
  signal?: AbortSignal,
): Promise<ProjectEvidence[]> {
  const result: ProjectEvidence[] = [];
  for (const project of projects) {
    signal?.throwIfAborted();
    const directory = await directoryIdentity(join(root, project.folder));
    const file = join(directory.path, 'project.sqlite');
    const database = await requireDatabase(file, signal);
    await requireIndependentDatabase(file);
    verifyProjectDatabase(file, project);
    await verifyDirectory(directory);
    if (!same(database, await requireDatabase(file, signal)))
      throw new Error('项目数据库在检查期间变化');
    result.push({ project, directory, database });
  }
  return result;
}
export async function inspectRelocation(
  userData: string,
  path: string,
  signal?: AbortSignal,
): Promise<RelocationInspection> {
  if (!isAbsolute(path) || path.includes('\0'))
    throw new Error('请选择原保存目录的完整路径');
  const current = await inspectApplication(userData, signal);
  const root = await directoryIdentity(resolve(path));
  if (overlaps(root.path, userData) || overlaps(userData, root.path))
    throw new Error('项目目录不能与应用资料目录相互包含');
  if (!sameIdentity(root, current.anchor.root))
    throw new Error('所选目录不是原保存目录对象；复制目录或跨磁盘移动暂不支持');
  const projects = await inspectProjects(
    root.path,
    projectsIn(current.data),
    signal,
  );
  await verifyDirectory(root);
  await requireMissingRoot(current.anchor.root.path);
  const after = await inspectApplication(userData, signal);
  if (!same(current, after))
    throw new Error('应用资料在检查期间变化，请重新检查');
  return {
    anchor: current.anchor,
    original: current.evidence,
    root,
    projects,
    pendingSaveCount: current.data.saves.filter(
      (row) => (JSON.parse(row.payload ?? '') as SaveJob).status !== 'saved',
    ).length,
  };
}
