import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  type CanvasDocument,
  reconcileCanvas,
} from '../../shared/canvas/model';
import type { ArkAdoptionResult } from '../../shared/generation/ark-types';
import {
  emptyGenerationDraft,
  validateGenerationDraft,
} from '../../shared/generation/draft';
import { duplicateShot } from '../../shared/generation/shot-duplication';
import {
  validateWorkspace,
  workspaceFromDraft,
} from '../../shared/generation/workspace';
import type { GenerationWorkspace } from '../../shared/generation/workspace-types';
import type {
  Asset,
  ProjectSnapshot,
  ProjectSummary,
  Viewport,
} from '../../shared/models';
import { withProject } from '../projects/project-database';
import type { ProjectIdentity } from '../projects/project-guard';
import type { ArkStoredJob } from './ark-journal';

type Receipt = Omit<ArkAdoptionResult, 'snapshot' | 'workspace'>;
function value<T>(db: DatabaseSync, key: string): T | undefined {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
  return row ? (JSON.parse(String(row.value)) as T) : undefined;
}
function put(db: DatabaseSync, key: string, payload: unknown) {
  db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)').run(
    key,
    JSON.stringify(payload),
  );
}
function state(db: DatabaseSync): {
  snapshot: ProjectSnapshot;
  workspace: GenerationWorkspace;
} {
  const project = value<ProjectSummary>(db, 'project');
  const viewport = value<Viewport>(db, 'viewport');
  if (!project || !viewport) throw new Error('项目内容不完整，候选结果已保留');
  const assets = db
    .prepare('SELECT payload FROM assets ORDER BY rowid')
    .all()
    .map((row) => JSON.parse(String(row.payload)) as Asset);
  const workspace = value<GenerationWorkspace>(db, 'generation-workspace');
  return {
    snapshot: {
      project,
      viewport,
      assets,
      canvas: reconcileCanvas(value<CanvasDocument>(db, 'canvas'), assets),
    },
    workspace: workspace
      ? validateWorkspace(workspace)
      : workspaceFromDraft(
          project.id,
          validateGenerationDraft(
            value(db, 'generation-draft') ?? emptyGenerationDraft(),
          ),
        ),
  };
}
/** Adoption and its receipt share the project transaction, so a lost IPC reply is safe to retry. */
export function adoptArkResult(
  file: string,
  expected: ProjectIdentity,
  job: ArkStoredJob,
  expectedRevision: number,
): ArkAdoptionResult {
  return withProject(
    file,
    true,
    (db) => {
      const current = state(db);
      const receipts = value<Receipt[]>(db, 'ark-adoptions') ?? [];
      const prior = receipts.find((item) => item.jobId === job.id);
      if (prior) return { ...prior, ...current };
      if (
        !Number.isSafeInteger(expectedRevision) ||
        current.workspace.revision !== expectedRevision
      )
        throw new Error(
          '镜头内容已变化，请保存并重新检查后采纳；候选结果已保留',
        );
      const source = current.workspace.shots.find(
        (item) => item.id === job.shotId,
      );
      if (!source?.groups.some((group) => group.id === job.groupId))
        throw new Error('原镜头或生成组已移除，候选结果仍被保留，未修改画布');
      const asset = current.snapshot.assets.find(
        (item) => item.id === job.saveJobId,
      );
      const row = job.saveJobId
        ? db
            .prepare('SELECT result_key FROM assets WHERE id = ?')
            .get(job.saveJobId)
        : undefined;
      if (
        !asset ||
        asset.kind !== job.kind ||
        asset.usage !== 'reference' ||
        row?.result_key !== job.resultKey ||
        asset.sha256 !== job.resultSha256 ||
        asset.size !== job.resultSize
      )
        throw new Error('候选结果尚未安全保存或记录不匹配，请先重试保存');
      let shotId = source.id;
      if (job.kind === 'image') {
        source.nodes.push({
          id: randomUUID(),
          type: 'asset',
          assetId: asset.id,
          name: asset.name,
          position: {
            x: 80,
            y: Math.min(
              99990000,
              Math.max(
                100,
                ...source.nodes.map(
                  (node) => node.position.y + (node.height ?? 244) + 32,
                ),
              ),
            ),
          },
        });
      } else {
        // Leave every existing card, grouping, trim and source shot untouched.
        const canvas = current.snapshot.canvas;
        const position = {
          x: 100,
          y: Math.min(
            99990000,
            Math.max(
              100,
              ...canvas.cards.map((card) => card.position.y + 252),
              ...current.workspace.shots
                .filter((shot) => !shot.sourceAssetId)
                .map((shot) => shot.position.y + 252),
            ),
          ),
        };
        const copy = duplicateShot(
          job.shotContext,
          current.workspace.shots,
          position,
        );
        copy.sourceAssetId = asset.id;
        shotId = copy.id;
        const allowedAssets = new Set(
          current.snapshot.assets.map((item) => item.id),
        );
        if (
          copy.nodes.some(
            (node) => node.type === 'asset' && !allowedAssets.has(node.assetId),
          )
        )
          throw new Error(
            '生成时的参考素材尚未全部保存，候选视频已保留；请完成参考素材保存后采纳',
          );
        current.workspace.shots.push(copy);
        delete asset.usage;
        db.prepare('UPDATE assets SET payload = ? WHERE id = ?').run(
          JSON.stringify(asset),
          asset.id,
        );
        canvas.cards.push({ id: randomUUID(), assetIds: [asset.id], position });
        canvas.revision++;
        current.snapshot.canvas = reconcileCanvas(
          canvas,
          current.snapshot.assets,
        );
        put(db, 'canvas', current.snapshot.canvas);
      }
      current.workspace = validateWorkspace({
        ...current.workspace,
        revision: expectedRevision + 1,
      });
      current.snapshot.project.updatedAt = new Date().toISOString();
      put(db, 'generation-workspace', current.workspace);
      put(db, 'project', current.snapshot.project);
      const receipt: Receipt = {
        jobId: job.id,
        assetId: asset.id,
        shotId,
        kind: job.kind,
        sourceShotId: job.shotId,
        baselineRevision: expectedRevision,
        committedRevision: current.workspace.revision,
      };
      put(db, 'ark-adoptions', [...receipts, receipt]);
      return { ...receipt, ...current };
    },
    expected,
  );
}
