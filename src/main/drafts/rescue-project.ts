import { lstat } from 'node:fs/promises';
import type { GenerationWorkspace } from '../../shared/generation/workspace';
import type {
  Asset,
  ProjectSnapshot,
  ProjectSummary,
} from '../../shared/models';
import { projectEditDraftState } from '../../shared/project-edit-draft';
import { workspaceDraftState } from '../../shared/workspace-draft';
import {
  isWorkspaceRescue,
  type RescueRecord,
  stableRescueValue,
} from './rescue-record';
import { inspectRescueMedia } from './rescue-source';

export interface RescueProjectAccess {
  summary(id: string): ProjectSummary;
  read(id: string): Promise<ProjectSnapshot>;
  readWorkspace(id: string): Promise<GenerationWorkspace>;
  databasePath(id: string): Promise<string>;
  resolveAsset(projectId: string, asset: Asset): Promise<string>;
  assertAvailable(): void;
  run<T>(operation: () => Promise<T>): Promise<T>;
}

function references(record: RescueRecord) {
  const result = new Map<string, boolean>();
  if (!isWorkspaceRescue(record)) {
    if (record.kind === 'trim')
      for (const id of record.baseline.assetIds) result.set(id, true);
    return result;
  }
  for (const workspace of [
    record.baseline,
    record.workspace,
    record.lastSubmitted,
  ]) {
    if (!workspace) continue;
    for (const shot of workspace.shots) {
      if (shot.sourceAssetId) result.set(shot.sourceAssetId, true);
      for (const node of shot.nodes)
        if (node.type === 'asset' && !result.has(node.assetId))
          result.set(node.assetId, false);
    }
  }
  return result;
}

/** Called under the project write gate; all external files remain read-only. */
export async function inspectRescueProject(
  access: RescueProjectAccess,
  record: RescueRecord,
) {
  access.assertAvailable();
  const id = record.project.id;
  const project = access.summary(id);
  if (project.id !== id || project.folder !== record.project.folder)
    throw new Error('救援文件的原项目身份不匹配，不能导入到其他项目');
  const path = await access.databasePath(id);
  const database = await inspectRescueMedia(path, (await lstat(path)).size);
  const snapshot = await access.read(id);
  if (snapshot.project.id !== id || snapshot.project.folder !== project.folder)
    throw new Error('项目数据库身份已变化');
  const workspace = await access.readWorkspace(id);
  const referenced = references(record);
  const indexed = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
  if (indexed.size !== snapshot.assets.length)
    throw new Error('项目素材记录重复');
  const media = [];
  for (const [assetId, video] of referenced) {
    access.assertAvailable();
    const asset = indexed.get(assetId);
    if (!asset || (video && asset.kind !== 'video'))
      throw new Error(
        `救援文件引用的素材未保存在原项目中（${assetId}）；请先完成保存或修复素材`,
      );
    const file = await inspectRescueMedia(
      await access.resolveAsset(id, asset),
      asset.size,
    );
    media.push({ id: assetId, ...file });
  }
  access.assertAvailable();
  const afterPath = await access.databasePath(id);
  const after = await inspectRescueMedia(
    afterPath,
    (await lstat(afterPath)).size,
  );
  if (stableRescueValue(database) !== stableRescueValue(after))
    throw new Error('项目在检查期间变化，请重新检查救援文件');
  return {
    project: {
      id: project.id,
      folder: project.folder,
      name: snapshot.project.name,
    },
    state: isWorkspaceRescue(record)
      ? workspaceDraftState(record, workspace)
      : projectEditDraftState(record, snapshot),
    referenceCount: referenced.size,
    evidence: stableRescueValue({ database, snapshot, workspace, media }),
  };
}
