import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  realpathSync,
} from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  ARK_PROFILES,
  type ArkGenerationJob,
  type ArkModelBinding,
} from '../../shared/generation/ark-types';
import {
  emptyGenerationDraft,
  validateGenerationDraft,
} from '../../shared/generation/draft';
import { validateImageParameters } from '../../shared/generation/image-generation';
import { validateWorkspace } from '../../shared/generation/workspace';
import type { ShotWorkspace } from '../../shared/generation/workspace-types';
import { existingDatabaseLocation, openDatabase } from '../storage/database';

export interface ArkStoredJob extends ArkGenerationJob {
  requestHash: string;
  recoveryMarker: string;
  verifiedWithoutQueue?: true;
  shotContext: ShotWorkspace;
  /** Private signed URL. Never returned through the bridge. */
  resultUrl?: string;
  resultReceivedAt?: string;
  downloadAttempt: number;
  resultKey?: string;
  resultSha256?: string;
  resultSize?: number;
}
export interface ArkStoredConfig {
  revision: number;
  models: ArkModelBinding[];
  encryptedKey?: string;
}

function storedConfig(value: unknown): ArkStoredConfig {
  const config = value as ArkStoredConfig;
  if (
    !config ||
    !Number.isSafeInteger(config.revision) ||
    config.revision < 0 ||
    !Array.isArray(config.models) ||
    config.models.length > 4 ||
    config.models.some(
      (binding) =>
        !binding ||
        !ARK_PROFILES.includes(binding.alias) ||
        binding.capability !== binding.alias ||
        typeof binding.modelId !== 'string',
    ) ||
    new Set(config.models.map((binding) => binding.alias)).size !==
      config.models.length ||
    (config.encryptedKey !== undefined &&
      (typeof config.encryptedKey !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(config.encryptedKey) ||
        config.encryptedKey.length > 32768))
  )
    throw new Error('方舟配置记录无效');
  return config;
}
function storedJob(value: unknown, rowId?: string): ArkStoredJob {
  const job = value as ArkStoredJob;
  const phases = [
    'submitting',
    'submission_unknown',
    'queued',
    'running',
    'downloading',
    'download_failed',
    'saving',
    'save_failed',
    'recovery_blocked',
    'candidate',
    'adopted',
    'failed',
    'cancelled',
    'expired',
  ];
  if (
    !job ||
    !/^[0-9a-f-]{36}$/i.test(job.id) ||
    (rowId !== undefined && rowId !== job.id) ||
    !/^[0-9a-f-]{36}$/i.test(job.projectId) ||
    typeof job.shotId !== 'string' ||
    typeof job.groupId !== 'string' ||
    !['image', 'video'].includes(job.kind) ||
    !ARK_PROFILES.includes(job.capability) ||
    typeof job.modelId !== 'string' ||
    typeof job.prompt !== 'string' ||
    job.prompt.length > 10000 ||
    !Array.isArray(job.references) ||
    job.references.length > 32 ||
    job.references.some(
      (ref) =>
        !ref ||
        typeof ref.nodeId !== 'string' ||
        !/^[a-zA-Z0-9:-]{1,100}$/.test(ref.nodeId) ||
        typeof ref.assetId !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(ref.assetId) ||
        typeof ref.name !== 'string' ||
        ref.name.length > 1000 ||
        !['image', 'video', 'audio', 'text'].includes(ref.kind) ||
        !Number.isSafeInteger(ref.bytes) ||
        ref.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(ref.sha256) ||
        (ref.role !== undefined &&
          !['reference_image', 'reference_audio', 'reference_video'].includes(
            ref.role,
          )),
    ) ||
    (job.error !== null &&
      (typeof job.error !== 'string' || job.error.length > 2000)) ||
    !/^[a-f0-9]{64}$/.test(job.recoveryMarker) ||
    (job.verifiedWithoutQueue !== undefined &&
      job.verifiedWithoutQueue !== true) ||
    (job.saveJobId !== undefined &&
      (typeof job.saveJobId !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(job.saveJobId))) ||
    (job.candidateAssetId !== undefined &&
      (typeof job.candidateAssetId !== 'string' ||
        job.candidateAssetId !== job.saveJobId)) ||
    (job.adoptedShotId !== undefined &&
      (typeof job.adoptedShotId !== 'string' ||
        !/^[a-zA-Z0-9:-]{1,100}$/.test(job.adoptedShotId))) ||
    (job.resultSha256 !== undefined &&
      (typeof job.resultSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(job.resultSha256))) ||
    (job.resultSize !== undefined &&
      (!Number.isSafeInteger(job.resultSize) || job.resultSize < 1)) ||
    (job.resultKey !== undefined &&
      (typeof job.resultKey !== 'string' ||
        !job.resultKey.startsWith(`ark:${job.id}:download:`) ||
        job.resultKey.length > 300)) ||
    (job.imageSize !== undefined &&
      (typeof job.imageSize !== 'string' ||
        !/^(?:[234]K|[0-9]{3,5}x[0-9]{3,5})$/.test(job.imageSize))) ||
    (job.resultReceivedAt !== undefined &&
      (typeof job.resultReceivedAt !== 'string' ||
        !Number.isFinite(Date.parse(job.resultReceivedAt)))) ||
    !phases.includes(job.phase) ||
    typeof job.locallyStopped !== 'boolean' ||
    !Number.isSafeInteger(job.downloadAttempt) ||
    job.downloadAttempt < 0 ||
    !/^[a-f0-9]{64}$/.test(job.requestHash) ||
    !Number.isFinite(Date.parse(job.createdAt)) ||
    !Number.isFinite(Date.parse(job.updatedAt)) ||
    (job.remoteTaskId !== undefined &&
      (typeof job.remoteTaskId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(job.remoteTaskId))) ||
    (job.resultUrl !== undefined &&
      (typeof job.resultUrl !== 'string' || job.resultUrl.length > 16384))
  )
    throw new Error('方舟任务记录无效');
  validateWorkspace({ version: 1, revision: 0, shots: [job.shotContext] });
  const group = job.shotContext.groups.find((item) => item.id === job.groupId);
  if (
    job.shotContext.id !== job.shotId ||
    !group ||
    (group.kind === 'image' ? 'image' : 'video') !== job.kind ||
    group.parameters.model !== job.capability
  )
    throw new Error('方舟任务来源记录无效');
  if (job.kind === 'image') validateImageParameters(job.parameters);
  else
    validateGenerationDraft({
      ...emptyGenerationDraft(),
      parameters: job.parameters,
    });
  if (
    job.parameters.model !== job.capability ||
    JSON.stringify(job.parameters) !== JSON.stringify(group.parameters)
  )
    throw new Error('方舟任务参数记录不匹配');
  if (
    ['queued', 'running', 'cancelled', 'expired'].includes(job.phase) &&
    (job.kind !== 'video' || !job.remoteTaskId)
  )
    throw new Error('方舟任务缺少远端任务 ID');
  if (
    ['downloading', 'download_failed'].includes(job.phase) &&
    !job.resultUrl &&
    !job.remoteTaskId
  )
    throw new Error('方舟任务缺少原结果记录');
  if (
    ['saving', 'save_failed', 'candidate', 'adopted'].includes(job.phase) &&
    (!job.saveJobId || !job.resultKey || !job.resultSha256 || !job.resultSize)
  )
    throw new Error('方舟任务缺少完整保存记录');
  if (job.phase === 'adopted' && !job.adoptedShotId)
    throw new Error('方舟任务缺少采纳记录');
  return job;
}

/** Separate from the restorable app index: restoring a backup cannot replay paid submissions. */
export class ArkJournal {
  private readonly db: DatabaseSync;
  private readonly identity: { dev: number; ino: number };
  constructor(private readonly file: string) {
    let created = false;
    try {
      closeSync(
        openSync(
          file,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        ),
      );
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      realpathSync(file) !== resolve(file)
    )
      throw new Error('云端任务记录位置异常，未覆盖原文件');
    this.identity = stat;
    this.db = openDatabase(existingDatabaseLocation(file), false, (db) => {
      this.assertPath();
      if (
        !created &&
        db.prepare('PRAGMA application_id').get()?.application_id !== 0x4146524b
      )
        throw new Error('云端任务记录格式不受支持，原文件已保留');
    });
    if (created) {
      this.db.exec(`CREATE TABLE config (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT NOT NULL);
        CREATE TABLE jobs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
        PRAGMA application_id = 1095127627;
        PRAGMA user_version = 1;`);
    }
    if (this.db.prepare('PRAGMA user_version').get()?.user_version !== 1) {
      this.db.close();
      throw new Error('云端任务记录版本不受支持');
    }
  }
  private assertPath() {
    const current = lstatSync(this.file);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.dev !== this.identity.dev ||
      current.ino !== this.identity.ino ||
      realpathSync(this.file) !== resolve(this.file)
    )
      throw new Error('云端任务记录文件已变化，请重新打开应用');
  }
  config(): ArkStoredConfig {
    this.assertPath();
    const row = this.db
      .prepare('SELECT payload FROM config WHERE id = 1')
      .get();
    return storedConfig(
      row ? JSON.parse(String(row.payload)) : { revision: 0, models: [] },
    );
  }
  putConfig(config: ArkStoredConfig) {
    this.assertPath();
    this.db
      .prepare('INSERT OR REPLACE INTO config VALUES (1, ?)')
      .run(JSON.stringify(config));
  }
  list(): ArkStoredJob[] {
    this.assertPath();
    return this.db
      .prepare('SELECT id, payload FROM jobs ORDER BY rowid DESC')
      .all()
      .map((row) => storedJob(JSON.parse(String(row.payload)), String(row.id)));
  }
  get(id: string): ArkStoredJob {
    this.assertPath();
    const row = this.db
      .prepare('SELECT payload FROM jobs WHERE id = ?')
      .get(id);
    if (!row) throw new Error('云端任务不存在');
    return storedJob(JSON.parse(String(row.payload)), id);
  }
  put(job: ArkStoredJob) {
    this.assertPath();
    this.db
      .prepare('INSERT OR REPLACE INTO jobs VALUES (?, ?)')
      .run(job.id, JSON.stringify(job));
  }
  close() {
    if (this.db.isOpen) this.db.close();
  }
}
