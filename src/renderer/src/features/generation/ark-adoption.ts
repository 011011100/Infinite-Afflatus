import { sameCard } from '../../../../shared/canvas/model';
import type {
  ArkAdoptionResult,
  ArkGenerationApi,
} from '../../../../shared/generation/ark-types';
import type { GenerationWorkspace } from '../../../../shared/generation/workspace';
import type { ProjectSnapshot } from '../../../../shared/models';
import { sameWorkspace } from '../../../../shared/workspace-draft';

export interface ArkAdoptionBaseline {
  jobId: string;
  project: ProjectSnapshot;
  workspace: GenerationWorkspace;
}

function sameValue(left: unknown, right: unknown): boolean {
  const encode = (value: unknown) =>
    JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, item[key]]),
          )
        : item,
    );
  return encode(left) === encode(right);
}

/** An adoption receipt permits one additive change, never an arbitrary remote reload. */
export function validateArkAdoption(
  baseline: ArkAdoptionBaseline,
  result: ArkAdoptionResult,
): void {
  const fail: () => never = () => {
    throw new Error(
      '生成结果采用回执与当前项目版本不一致，已保留当前内容和撤销记录；请重试核对，未覆盖其他修改。',
    );
  };
  const before = baseline.workspace;
  const after = result.workspace;
  if (
    result.jobId !== baseline.jobId ||
    result.snapshot.project.id !== baseline.project.project.id ||
    result.snapshot.project.folder !== baseline.project.project.folder ||
    result.baselineRevision !== before.revision ||
    result.committedRevision !== before.revision + 1 ||
    after.revision !== result.committedRevision ||
    after.version !== before.version
  )
    fail();
  const source = before.shots.find((shot) => shot.id === result.sourceShotId);
  if (!source) fail();
  if (result.kind === 'image') {
    const changed = after.shots.find((shot) => shot.id === source.id);
    if (
      result.shotId !== source.id ||
      !changed ||
      changed.nodes.length !== source.nodes.length + 1
    )
      fail();
    const added = changed.nodes.at(-1);
    if (
      added?.type !== 'asset' ||
      added.assetId !== result.assetId ||
      added.groupId !== undefined ||
      source.nodes.some((node) => node.id === added.id) ||
      !sameWorkspace(
        {
          ...after,
          revision: before.revision,
          shots: after.shots.map((shot) =>
            shot.id === source.id
              ? { ...shot, nodes: shot.nodes.slice(0, -1) }
              : shot,
          ),
        },
        before,
      )
    )
      fail();
  } else {
    const added = after.shots.at(-1);
    if (
      !added ||
      added.id !== result.shotId ||
      added.sourceAssetId !== result.assetId ||
      before.shots.some((shot) => shot.id === added.id) ||
      !sameWorkspace(
        {
          ...after,
          revision: before.revision,
          shots: after.shots.slice(0, -1),
        },
        before,
      )
    )
      fail();
  }
  validateArkProjectAdoption(baseline.project, result);
}

/** Preserve every existing combination/trim; only the adopted video's own card may be new. */
export function validateArkProjectAdoption(
  before: ProjectSnapshot,
  result: ArkAdoptionResult,
): void {
  const after = result.snapshot;
  const fail: () => never = () => {
    throw new Error(
      '采用期间主画布或素材记录发生变化，当前画布和撤销记录仍保留。',
    );
  };
  if (
    before.project.id !== after.project.id ||
    before.project.folder !== after.project.folder ||
    after.canvas.version !== before.canvas.version ||
    new Set(after.assets.map((asset) => asset.id)).size !== after.assets.length
  )
    fail();
  const candidate = after.assets.find((asset) => asset.id === result.assetId);
  if (
    !candidate ||
    candidate.kind !== result.kind ||
    (result.kind === 'video' && candidate.usage === 'reference')
  )
    fail();
  for (const asset of before.assets) {
    const current = after.assets.find((item) => item.id === asset.id);
    // Video candidates are kept off the main canvas until this transaction.
    const { usage: _usage, ...unreferenced } = asset;
    const expected =
      result.kind === 'video' && asset.id === result.assetId
        ? unreferenced
        : asset;
    if (!current || !sameValue(expected, current)) fail();
  }
  const previousIds = new Set(before.assets.map((asset) => asset.id));
  for (const asset of after.assets)
    if (
      !previousIds.has(asset.id) &&
      asset.id !== result.assetId &&
      asset.usage !== 'reference'
    )
      fail();
  const oldCards = before.canvas.cards;
  const newCards = after.canvas.cards;
  if (
    oldCards.some((card, index) => {
      const current = newCards[index];
      return !current || !sameCard(card, current);
    })
  )
    fail();
  if (result.kind === 'image') {
    if (
      newCards.length !== oldCards.length ||
      after.canvas.revision !== before.canvas.revision
    )
      fail();
  } else {
    const added = newCards.at(-1);
    if (
      newCards.length !== oldCards.length + 1 ||
      after.canvas.revision !== before.canvas.revision + 1 ||
      !added ||
      oldCards.some((card) => card.id === added.id) ||
      added.assetIds.length !== 1 ||
      added.assetIds[0] !== result.assetId ||
      added.trims !== undefined
    )
      fail();
  }
}

/** Retry only the identical local transaction; the backend receipt prevents duplication. */
export async function requestArkAdoption(
  bridge: Pick<ArkGenerationApi, 'adoptArkJob'>,
  baseline: ArkAdoptionBaseline,
): Promise<ArkAdoptionResult> {
  let result: ArkAdoptionResult;
  try {
    result = await bridge.adoptArkJob(
      baseline.jobId,
      baseline.workspace.revision,
    );
  } catch {
    result = await bridge.adoptArkJob(
      baseline.jobId,
      baseline.workspace.revision,
    );
  }
  validateArkAdoption(baseline, result);
  return result;
}

export interface ArkAdoptionCanvasLease {
  snapshot: ProjectSnapshot;
  accept(result: ArkAdoptionResult): void;
  resume(): void;
  pause(): void;
  finish(saved: boolean): void;
}

/** A failed call is safe to unlock only after independent reads prove no commit. */
export async function arkAdoptionDidNotCommit(
  bridge: Pick<ArkGenerationApi, 'listArkJobs'> & {
    getGenerationWorkspace(projectId: string): Promise<GenerationWorkspace>;
  },
  baseline: ArkAdoptionBaseline,
): Promise<boolean> {
  try {
    const projectId = baseline.project.project.id;
    const jobs = await bridge.listArkJobs(projectId);
    const job = jobs.find((item) => item.id === baseline.jobId);
    if (!job || job.phase === 'adopted' || job.adoptedShotId) return false;
    const workspace = await bridge.getGenerationWorkspace(projectId);
    return sameWorkspace(workspace, baseline.workspace);
  } catch {
    return false;
  }
}
