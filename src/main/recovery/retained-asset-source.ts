import type { BigIntStats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Asset, SaveJob } from '../../shared/models';
import type { ProjectService } from '../projects/project-service';
import type { Staging } from '../saving/staging';
import type { AppStore } from '../storage/app-store';
import { safeFile } from '../storage/files';
import { inspectAsset, validateAsset } from './asset-inspection';

interface Sources {
  projects: Pick<ProjectService, 'open' | 'databasePath'>;
  store: Pick<AppStore, 'jobs' | 'root'>;
  staging: Pick<Staging, 'directory' | 'path'>;
}

/** Native-only selection evidence. This is not a content verification result. */
export interface RetainedAssetSource {
  projectId: string;
  assetId: string;
  name: string;
  bytes: number;
  path: string;
  root: string;
  rootIdentity: string;
  project: string;
  asset: string;
  job: string;
  database: string;
  databaseIdentity: string;
  projectDirectory: string;
  stagingDirectory: string;
  source: string;
}

const changed = () =>
  new Error('保留副本或项目状态已变化，未恢复或删除文件，请重新检查项目素材');

function identity(info: BigIntStats): string {
  return [info.dev, info.ino, info.birthtimeNs].join(':');
}

async function directoryIdentity(path: string): Promise<string> {
  const info = await lstat(path, { bigint: true });
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== resolve(path)
  )
    throw changed();
  return identity(info);
}

function matches(job: SaveJob, projectId: string, asset: Asset): boolean {
  return (
    job.status === 'saved' &&
    job.projectId === projectId &&
    job.id === asset.id &&
    job.name === asset.name &&
    job.size === asset.size &&
    job.sha256 === asset.sha256 &&
    job.kind === asset.kind &&
    job.usage === asset.usage &&
    job.outputRelativePath === asset.relativePath
  );
}

/** Only metadata and file identity are read here; health.restore verifies all bytes. */
async function readCandidate(
  sources: Sources,
  projectId: string,
  assetId: string,
): Promise<RetainedAssetSource | null> {
  const root = sources.store.root;
  const rootIdentity = await directoryIdentity(root);
  const database = await sources.projects.databasePath(projectId);
  const databaseInfo = await lstat(database, { bigint: true });
  if (!databaseInfo.isFile() || databaseInfo.isSymbolicLink()) throw changed();
  const snapshot = await sources.projects.open(projectId);
  const asset = snapshot.assets.find((item) => item.id === assetId);
  if (!asset) throw new Error('素材不存在，请重新检查项目');
  validateAsset(asset);
  const job = sources.store.jobs().find((item) => item.id === assetId);
  if (!job || !matches(job, projectId, asset)) return null;
  const projectRoot = dirname(database);
  const issue = await inspectAsset(
    projectRoot,
    asset,
    'quick',
    new AbortController().signal,
    () => {},
  );
  if (issue?.problem !== 'missing') return null;
  const projectDirectory = await directoryIdentity(projectRoot);
  try {
    const stagingDirectory = await directoryIdentity(sources.staging.directory);
    const path = await safeFile(sources.staging.directory, `${asset.id}.ready`);
    if (path !== sources.staging.path(asset.id)) throw changed();
    const info = await lstat(path, { bigint: true });
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== BigInt(asset.size)
    )
      return null;
    return {
      projectId,
      assetId,
      name: asset.name,
      bytes: asset.size,
      path,
      root,
      rootIdentity,
      project: JSON.stringify({
        id: snapshot.project.id,
        folder: snapshot.project.folder,
      }),
      asset: JSON.stringify(asset),
      job: JSON.stringify(job),
      database,
      databaseIdentity: identity(databaseInfo),
      projectDirectory,
      stagingDirectory,
      source: [identity(info), info.size, info.mtimeNs, info.ctimeNs].join(':'),
    };
  } catch {
    // Discovery is optional: absent, unreadable or unsafe staging must not
    // prevent explicitly choosing an external original. An already-confirmed
    // candidate still turns this null into a refusal in validation below.
    return null;
  }
}

export async function findRetainedAssetSource(
  sources: Sources,
  projectId: string,
  assetId: string,
): Promise<RetainedAssetSource | null> {
  const candidate = await readCandidate(sources, projectId, assetId);
  // Do not present a mixture of states if a background write or external move
  // occurs between the project read and asynchronous directory/file checks.
  if (candidate) await validateRetainedAssetSource(sources, candidate);
  return candidate;
}

export async function validateRetainedAssetSource(
  sources: Sources,
  expected: RetainedAssetSource,
): Promise<string> {
  let current: RetainedAssetSource | null;
  try {
    current = await readCandidate(
      sources,
      expected.projectId,
      expected.assetId,
    );
  } catch {
    throw changed();
  }
  if (!current || JSON.stringify(current) !== JSON.stringify(expected))
    throw changed();
  // A background save may change a job while the asynchronous file checks run.
  if (
    sources.store.root !== expected.root ||
    JSON.stringify(
      sources.store.jobs().find((job) => job.id === expected.assetId),
    ) !== expected.job
  )
    throw changed();
  return expected.path;
}
