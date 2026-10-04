import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateGenerationDraft } from '../../shared/generation/draft';
import type { GenerationWorkspace } from '../../shared/generation/workspace';
import type { ProjectSnapshot, ProjectSummary } from '../../shared/models';
import { draftRecord } from '../drafts/draft-validation';
import { projectEditRecord } from '../drafts/project-edit-validation';
import { readWorkspace } from '../generation/workspace-database';
import {
  readGenerationDraft,
  readProject,
  verifyProjectDatabase,
} from '../projects/project-database';
import { fingerprint, safeFile } from '../storage/files';
import { type BackupAnchor, stableAnchor } from './backup-anchor';
import {
  directoryIdentity,
  type FileIdentity,
  identity,
  info,
  MAX_DATABASE_BYTES,
  readJson,
  UUID,
} from './backup-files';

export interface FileEvidence extends FileIdentity {
  size: string;
  modified: string;
  sha256: string;
}
export async function fileEvidence(path: string): Promise<FileEvidence | null> {
  const before = await info(path);
  if (!before) return null;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > BigInt(MAX_DATABASE_BYTES)
  )
    throw new Error('恢复涉及的数据库或记录不是受支持的普通文件，原文件已保留');
  const hash = await fingerprint(path);
  const after = await info(path);
  if (
    !after ||
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.mtimeNs !== after.mtimeNs ||
    before.size !== after.size
  )
    throw new Error('恢复涉及的文件正在变化，请重新检查');
  return {
    ...identity(before),
    size: String(before.size),
    modified: String(before.mtimeNs),
    sha256: hash.sha256,
  };
}
export interface RetainedFile {
  name: string;
  type: 'file' | 'directory' | 'link' | 'other';
  size: string;
  identity: FileIdentity;
  modified: string;
}
export async function stagingInventory(
  userData: string,
): Promise<RetainedFile[]> {
  const directory = join(userData, 'staging');
  if (!(await info(directory))) return [];
  await directoryIdentity(directory);
  const names = (await readdir(directory)).sort();
  if (names.length > 100000)
    throw new Error('暂存目录文件过多，未自动恢复索引');
  return Promise.all(
    names.map(async (name) => {
      const stat = await info(join(directory, name));
      if (!stat) throw new Error('暂存文件在检查期间变化，请重新检查');
      return {
        name,
        type: stat.isSymbolicLink()
          ? 'link'
          : stat.isFile()
            ? 'file'
            : stat.isDirectory()
              ? 'directory'
              : 'other',
        size: String(stat.size),
        identity: identity(stat),
        modified: String(stat.mtimeNs),
      } satisfies RetainedFile;
    }),
  );
}
function checkReferences(project: ProjectSnapshot, ids: Iterable<string>) {
  const registered = new Set(project.assets.map((asset) => asset.id));
  for (const id of ids)
    if (!registered.has(id))
      throw new Error(
        `项目“${project.project.name}”或其恢复草稿仍引用未保存的暂存素材；已保留全部资料，暂不能恢复旧索引`,
      );
}
function references(workspace: GenerationWorkspace) {
  return workspace.shots.flatMap((shot) => [
    ...(shot.sourceAssetId ? [shot.sourceAssetId] : []),
    ...shot.nodes.flatMap((node) =>
      node.type === 'asset' ? [node.assetId] : [],
    ),
  ]);
}
export interface RestoreInspection {
  anchor: BackupAnchor;
  projects: ProjectSummary[];
  files: Record<string, FileEvidence>;
  current: Record<string, FileEvidence | null>;
  staging: RetainedFile[];
}
/** Only current project databases establish project membership; old queue rows never establish assets. */
export async function inspectRestore(
  userData: string,
  backedProjects: ProjectSummary[],
): Promise<RestoreInspection> {
  const anchor = await stableAnchor(userData);
  const files: Record<string, FileEvidence> = {};
  const projects = new Map<string, ProjectSnapshot>();
  const entries = (await readdir(anchor.root.path))
    .filter((name) => UUID.test(name))
    .sort();
  if (entries.length > 10000) throw new Error('项目数量过多，未自动恢复索引');
  const known = new Map(
    backedProjects.map((project) => [project.folder, project]),
  );
  for (const folder of entries) {
    const path = join(anchor.root.path, folder);
    await directoryIdentity(path);
    const database = await safeFile(path, 'project.sqlite');
    for (const suffix of ['-wal', '-shm', '-journal'])
      if (await info(`${database}${suffix}`))
        throw new Error(
          '项目数据库仍有 SQLite 日志，请先安全关闭原应用；未恢复旧索引',
        );
    const evidence = await fileEvidence(database);
    if (!evidence) throw new Error('项目数据库已缺失，未恢复旧索引');
    const expected = known.get(folder) ?? { id: folder, folder };
    verifyProjectDatabase(database, expected);
    const project = readProject(database, expected);
    checkReferences(project, references(readWorkspace(database, expected)));
    checkReferences(
      project,
      validateGenerationDraft(readGenerationDraft(database, expected))
        .referenceIds,
    );
    checkReferences(
      project,
      project.canvas.cards.flatMap((card) => card.assetIds),
    );
    if (
      JSON.stringify(await fileEvidence(database)) !== JSON.stringify(evidence)
    )
      throw new Error('项目在检查期间变化，请重新检查');
    files[database] = evidence;
    projects.set(project.project.id, project);
  }
  for (const old of backedProjects)
    if (!projects.has(old.id))
      throw new Error(`原项目“${old.name}”已缺失或位置变化，未恢复旧索引`);
  for (const directoryName of [
    'workspace-drafts',
    'project-edit-drafts',
  ] as const) {
    const directory = join(userData, directoryName);
    if (!(await info(directory))) continue;
    await directoryIdentity(directory);
    const names = (await readdir(directory)).sort();
    if (names.length > 4096)
      throw new Error('独立恢复草稿数量过多，未自动恢复索引');
    for (const name of names) {
      // Managed records and unfinished writes are preserved. Unknown JSON is not silently ignored.
      if (!name.endsWith('.json')) continue;
      const path = await safeFile(directory, name);
      const evidence = await fileEvidence(path);
      if (!evidence) throw new Error('恢复草稿正在变化');
      if (directoryName === 'workspace-drafts') {
        const record = draftRecord(await readJson(path));
        const project = projects.get(record.project.id);
        if (!project || project.project.folder !== record.project.folder)
          throw new Error('恢复草稿对应的项目已缺失');
        for (const workspace of [
          record.baseline,
          record.workspace,
          record.lastSubmitted,
        ])
          if (workspace) checkReferences(project, references(workspace));
      } else {
        const record = projectEditRecord(await readJson(path));
        const project = projects.get(record.project.id);
        if (!project || project.project.folder !== record.project.folder)
          throw new Error('项目编辑恢复草稿对应的项目已缺失');
        if (record.kind === 'trim')
          checkReferences(
            project,
            record.assets.map((asset) => asset.id),
          );
      }
      if (JSON.stringify(await fileEvidence(path)) !== JSON.stringify(evidence))
        throw new Error('恢复草稿在检查期间变化');
      files[path] = evidence;
    }
  }
  const current: RestoreInspection['current'] = {};
  for (const suffix of ['', '-journal', '-wal', '-shm'])
    current[`app.sqlite${suffix}`] = await fileEvidence(
      join(userData, `app.sqlite${suffix}`),
    );
  return {
    anchor,
    projects: [...projects.values()].map((item) => item.project),
    files,
    current,
    staging: await stagingInventory(userData),
  };
}
