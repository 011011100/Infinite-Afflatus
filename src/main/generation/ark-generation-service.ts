import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  ARK_ENDPOINT,
  type ArkAdoptionResult,
  type ArkConfigurationInput,
  type ArkGenerationJob,
  type ArkGenerationPreview,
  type ArkGenerationTarget,
} from '../../shared/generation/ark-types';
import type { GenerationWorkspace } from '../../shared/generation/workspace-types';
import type { ProjectService } from '../projects/project-service';
import { ordinaryFileStateSync } from '../saving/file-state';
import type { ProjectReferenceReader } from '../saving/project-reference-reader';
import type { SaveQueue } from '../saving/save-queue';
import type { Staging } from '../saving/staging';
import type { AppStore } from '../storage/app-store';
import type { WriteGate } from '../storage/write-gate';
import { adoptArkResult } from './ark-adoption';
import {
  ArkConfigurationStore,
  type ArkSecretStorage,
} from './ark-configuration';
import { ArkJournal, type ArkStoredJob } from './ark-journal';
import { verifyArkCommittedResult } from './ark-result-recovery';
import { snapshotArkRequest } from './ark-snapshot';
import {
  ArkHttpTransport,
  ArkRequestError,
  type ArkTransport,
} from './ark-transport';

export interface ArkGenerationOptions {
  userData: string;
  projects: ProjectService;
  store: AppStore;
  gate: WriteGate;
  staging: Staging;
  saves: SaveQueue;
  references: ProjectReferenceReader;
  readWorkspace(projectId: string): Promise<GenerationWorkspace>;
  notify(): void;
  secrets?: ArkSecretStorage;
  transport?: ArkTransport;
  /** Test fixtures can suppress scheduling without changing production behavior. */
  pollIntervalMs?: number;
}
const ongoing = new Set([
  'submitting',
  'queued',
  'running',
  'downloading',
  'saving',
  'recovery_blocked',
]);
const uncertain =
  '上次提交结果无法确认；不会自动重新生成或重发。请在方舟控制台核对任务和账单';
const blockedRecovery =
  '应用索引曾恢复或原保存记录缺失，结果已保留。请恢复包含该任务的原应用索引，或先核对项目内已保存结果；不会自动重放保存、下载或生成';
const disabled =
  '方舟本地任务记录无法安全读取，云端功能已暂停；原文件已保留，本地项目仍可使用';
function resumableOriginalTask(job: ArkStoredJob): boolean {
  return (
    job.phase === 'recovery_blocked' &&
    !!job.remoteTaskId &&
    !job.saveJobId &&
    !job.resultKey &&
    !job.resultUrl
  );
}
interface PreviewEntry {
  owner: string | number;
  preview: ArkGenerationPreview;
  hash: string;
  configRevision: number;
}

/** Paid generation, downloading, saving and adoption have distinct durable states. */
export class ArkGenerationService {
  private journal: ArkJournal | undefined;
  private configuration: ArkConfigurationStore | undefined;
  private initializationError?: string;
  private readonly transport: ArkTransport;
  private readonly previews = new Map<string, PreviewEntry>();
  private readonly listeners = new Set<() => void>();
  private readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly preparing = new Set<string>();
  private readonly saveRetries = new Set<string>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly options: ArkGenerationOptions) {
    this.transport = options.transport ?? new ArkHttpTransport();
    try {
      this.journal = new ArkJournal(
        join(options.userData, 'ark-generation.sqlite'),
      );
      this.configuration = new ArkConfigurationStore(
        this.journal,
        options.secrets,
      );
      // Corrupt optional cloud state cannot prevent opening local projects.
      this.journal.list();
      this.configuration.state();
    } catch {
      this.journal?.close();
      this.journal = undefined;
      this.configuration = undefined;
      this.initializationError = disabled;
    }
  }
  private ready() {
    if (this.closed) throw new Error('应用正在关闭，请重新打开后使用云端生成');
    if (!this.journal || !this.configuration || this.initializationError)
      throw new Error(this.initializationError ?? disabled);
    return { journal: this.journal, configuration: this.configuration };
  }
  config() {
    if (!this.configuration)
      return {
        endpoint: ARK_ENDPOINT,
        hasKey: false,
        secureStorageAvailable: false,
        models: [],
        error: this.initializationError ?? disabled,
      };
    try {
      return this.configuration.state();
    } catch {
      this.initializationError = disabled;
      return {
        endpoint: ARK_ENDPOINT,
        hasKey: false,
        secureStorageAvailable: false,
        models: [],
        error: disabled,
      };
    }
  }
  configure(
    input: ArkConfigurationInput,
    assertCurrent: () => void = () => {},
  ) {
    const { configuration } = this.ready();
    assertCurrent();
    const result = configuration.save(input, assertCurrent);
    this.previews.clear();
    this.emit();
    return result;
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot alter durable work. */
      }
    }
    try {
      this.options.notify();
    } catch {
      /* No secrets or provider payload in logs. */
    }
  }
  private put(job: ArkStoredJob) {
    job.updatedAt = new Date().toISOString();
    this.journal?.put(job);
    this.emit();
  }
  private public(job: ArkStoredJob): ArkGenerationJob {
    const {
      id,
      projectId,
      shotId,
      groupId,
      kind,
      modelId,
      capability,
      prompt,
      parameters,
      references,
      imageSize,
      phase,
      createdAt,
      updatedAt,
      remoteTaskId,
      locallyStopped,
      saveJobId,
      candidateAssetId,
      adoptedShotId,
      error,
    } = job;
    return structuredClone({
      id,
      projectId,
      shotId,
      groupId,
      kind,
      modelId,
      capability,
      prompt,
      parameters,
      references,
      ...(imageSize ? { imageSize } : {}),
      phase,
      createdAt,
      updatedAt,
      ...(remoteTaskId ? { remoteTaskId } : {}),
      locallyStopped,
      ...(resumableOriginalTask(job) ? { canResumeOriginalTask: true } : {}),
      ...(saveJobId ? { saveJobId } : {}),
      ...(candidateAssetId ? { candidateAssetId } : {}),
      ...(adoptedShotId ? { adoptedShotId } : {}),
      error,
    });
  }
  list(projectId: string, shotId?: string, groupId?: string) {
    if (!this.journal || this.initializationError) return [];
    return this.journal
      .list()
      .filter(
        (job) =>
          job.projectId === projectId &&
          (!shotId || job.shotId === shotId) &&
          (!groupId || job.groupId === groupId),
      )
      .map((job) => this.public(this.syncSave(job)));
  }
  private recoveryMarker() {
    return createHash('sha256')
      .update(JSON.stringify(this.options.store.get('appBackupRecovery')))
      .digest('hex');
  }
  private targetKey(target: ArkGenerationTarget) {
    return `${target.projectId}:${target.shotId}:${target.groupId}`;
  }
  private assertNoActive(target: ArkGenerationTarget) {
    if (
      this.ready()
        .journal.list()
        .some(
          (job) =>
            this.targetKey(job) === this.targetKey(target) &&
            (ongoing.has(this.syncSave(job).phase) ||
              this.active.has(job.id) ||
              this.saveRetries.has(job.id)),
        )
    )
      throw new Error(
        '这个生成组已有未结束的任务，请先处理原任务；不会重复提交',
      );
  }
  async preview(
    owner: string | number,
    target: ArkGenerationTarget,
    assertCurrent: () => void = () => {},
  ): Promise<ArkGenerationPreview> {
    const { journal, configuration } = this.ready();
    this.assertNoActive(target);
    configuration.key(); // Verify secure storage before reading potentially large references.
    const workspace = await this.options.readWorkspace(target.projectId);
    const group = workspace.shots
      .find((item) => item.id === target.shotId)
      ?.groups.find((item) => item.id === target.groupId);
    const config = journal.config();
    const binding = config.models.find(
      (item) => item.alias === group?.parameters.model,
    );
    if (!binding)
      throw new Error(
        '请先在设置中为该模型填写真实 Model ID 或 Endpoint ID，并确认能力版本',
      );
    const request = await snapshotArkRequest(target, binding, {
      ...this.options,
      references: this.options.references,
    });
    this.ready();
    if (journal.config().revision !== config.revision)
      throw new Error('方舟配置已变化，请重新检查');
    const preview: ArkGenerationPreview = {
      ...request.summary,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 5 * 60000).toISOString(),
      transmissionNotice:
        '确认后会将这里显示的提示词和参考素材内容发送到火山方舟中国区，用于这一次生成。',
      costNotice:
        '这是一次可能计费的云端请求。应用无法确定本次实际费用或退款；具体按方舟账户、所选模型及实际用量结算。仅在接受该计费方式时确认。',
      warnings: [
        ...journal
          .list()
          .filter(
            (job) =>
              this.targetKey(job) === this.targetKey(target) &&
              job.phase === 'submission_unknown',
          )
          .map(
            (job) =>
              `重要：此前任务 ${job.id.slice(0, 8)} 的提交结果尚不明确，可能已被接受并计费。本次确认会创建一条全新的付费请求，可能重复计费；旧任务记录仍保留，请先核对控制台。`,
          ),
        ...journal
          .list()
          .filter(
            (job) =>
              this.targetKey(job) === this.targetKey(target) &&
              ['download_failed', 'save_failed'].includes(job.phase),
          )
          .map(
            (job) =>
              `重要：此前任务 ${job.id.slice(0, 8)} 的下载或保存尚未完成，旧任务记录及已接收的文件继续保留。本次确认会创建一条全新的付费生成请求，可能再次计费；这不是原结果的下载或保存重试。`,
          ),
        '关闭应用或停止本地查询不会取消云端任务，也不保证停止计费。',
        '结果链接通常仅有效 24 小时，应用开启时会尽快下载；请及时处理下载失败。',
        ...(binding.modelId === 'doubao-seedream-5-0-lite-260128' ||
        binding.alias === 'seedream-4.5'
          ? [
              '所选模型或别名在官方文档中标为即将下线，请先在方舟控制台确认仍可用；不会自动换用其他模型。',
            ]
          : []),
      ],
    };
    assertCurrent();
    this.cancelPreview(owner);
    this.previews.set(preview.token, {
      owner,
      preview,
      hash: request.hash,
      configRevision: config.revision,
    });
    return structuredClone(preview);
  }
  cancelPreview(owner: string | number, token?: string) {
    for (const [id, preview] of this.previews)
      if (preview.owner === owner && (!token || token === id))
        this.previews.delete(id);
  }
  async submit(
    owner: string | number,
    token: string,
    assertCurrent: () => void = () => {},
  ): Promise<ArkGenerationJob> {
    const { journal, configuration } = this.ready();
    const entry = this.previews.get(token);
    if (!entry || entry.owner !== owner)
      throw new Error('确认已过期或已经使用，请重新检查生成请求');
    this.previews.delete(token); // Consume synchronously, before any revalidation awaits.
    if (Date.parse(entry.preview.expiresAt) < Date.now())
      throw new Error('确认已过期，请重新检查生成请求');
    const key = this.targetKey(entry.preview);
    if (this.preparing.has(key))
      throw new Error('这个生成组正在提交，请勿重复确认');
    this.preparing.add(key);
    try {
      this.assertNoActive(entry.preview);
      const config = journal.config();
      if (config.revision !== entry.configRevision)
        throw new Error('配置已变化，请重新检查');
      const binding = config.models.find(
        (item) =>
          item.alias === entry.preview.capability &&
          item.modelId === entry.preview.modelId,
      );
      if (!binding) throw new Error('模型配置已变化，请重新检查');
      const snapshot = await snapshotArkRequest(
        entry.preview,
        binding,
        this.options,
      );
      this.ready();
      if (
        snapshot.hash !== entry.hash ||
        journal.config().revision !== entry.configRevision
      )
        throw new Error(
          '提示词、参数、参考素材或镜头内容已变化；未提交，请重新检查',
        );
      this.assertNoActive(entry.preview);
      const apiKey = configuration.key();
      assertCurrent();
      const now = new Date().toISOString();
      const job: ArkStoredJob = {
        ...snapshot.summary,
        id: randomUUID(),
        requestHash: snapshot.hash,
        recoveryMarker: this.recoveryMarker(),
        shotContext: snapshot.shotContext,
        phase: 'submitting',
        locallyStopped: false,
        createdAt: now,
        updatedAt: now,
        downloadAttempt: 0,
        error: null,
      };
      this.put(job); // FULL synchronous SQLite commit precedes the network POST.
      this.run(job.id, async (signal) => {
        try {
          if (job.kind === 'image') {
            const result = await this.transport.createImage(
              snapshot.request,
              apiKey,
              signal,
            );
            job.resultUrl = result.url;
            job.resultReceivedAt = new Date().toISOString();
            job.phase = 'download_failed';
          } else {
            const result = await this.transport.createVideo(
              snapshot.request,
              apiKey,
              signal,
            );
            job.remoteTaskId = result.id;
            job.phase = 'queued';
          }
          // Preserve a known remote ID/result even when shutdown arrived during the response.
          this.put(job);
          if (this.closed || signal.aborted) return;
          if (job.resultUrl) await this.download(job, signal);
          else this.schedule(job.id);
        } catch (error) {
          if (job.remoteTaskId || job.resultUrl)
            throw new Error('云端结果登记失败，原记录已保留');
          job.phase =
            error instanceof ArkRequestError && !error.submissionUnknown
              ? 'failed'
              : 'submission_unknown';
          job.error =
            error instanceof ArkRequestError ? error.message : uncertain;
          this.put(job);
        }
      });
      return this.public(job);
    } finally {
      this.preparing.delete(key);
    }
  }
  private run(
    id: string,
    operation: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const existing = this.active.get(id);
    if (existing) return existing.done;
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(() => operation(controller.signal))
      .catch(() => {
        // Each operation persists its own sanitized recoverable status. A journal
        // failure disables cloud writes instead of leaking raw provider details.
        this.initializationError = disabled;
        this.emit();
      })
      .finally(() => {
        if (this.active.get(id)?.controller === controller)
          this.active.delete(id);
      });
    this.active.set(id, { controller, done });
    return done;
  }
  private schedule(id: string, delay = this.options.pollIntervalMs ?? 10000) {
    if (this.closed || this.timers.has(id) || delay < 0) return;
    const job = this.journal?.get(id);
    if (
      !job ||
      job.locallyStopped ||
      !['queued', 'running'].includes(job.phase)
    )
      return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      if (!this.closed) void this.refresh(id).catch(() => undefined);
    }, delay);
    timer.unref();
    this.timers.set(id, timer);
  }
  private clearTimer(id: string) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }
  private syncSave(job: ArkStoredJob): ArkStoredJob {
    if (
      ![
        'adopted',
        'failed',
        'cancelled',
        'expired',
        'submission_unknown',
      ].includes(job.phase) &&
      job.recoveryMarker !== this.recoveryMarker()
    ) {
      if (job.phase !== 'recovery_blocked' || job.error !== blockedRecovery) {
        job.phase = 'recovery_blocked';
        job.error = blockedRecovery;
        job.locallyStopped = true;
        this.put(job);
      }
      return job;
    }
    if (
      ![
        'downloading',
        'download_failed',
        'saving',
        'save_failed',
        'candidate',
      ].includes(job.phase)
    )
      return job;
    const save = this.options.store
      .jobs()
      .find(
        (item) =>
          item.projectId === job.projectId && item.resultKey === job.resultKey,
      );
    if (!save) {
      if (job.saveJobId && !job.verifiedWithoutQueue) {
        job.phase = 'recovery_blocked';
        job.locallyStopped = true;
        job.error = blockedRecovery;
        this.put(job);
      }
      return job;
    }
    if (!save.sha256 || !save.size) return job;
    if (save.status === 'failed') {
      let ready = false;
      try {
        ready = !!ordinaryFileStateSync(this.options.staging.path(save.id));
      } catch {
        /* An unsafe ready path is not a complete result. */
      }
      if (!ready) {
        job.phase = 'download_failed';
        job.error =
          '原结果的暂存发布未完成，原文件仍被保留。请重试下载同一个结果；链接过期时需要核对保留文件，不必重新生成';
        delete job.resultKey;
        delete job.saveJobId;
        delete job.candidateAssetId;
        delete job.resultSha256;
        delete job.resultSize;
        this.put(job);
        return job;
      }
    }
    const nextPhase =
      save.status === 'saved'
        ? 'candidate'
        : save.status === 'failed'
          ? 'save_failed'
          : 'saving';
    const nextError =
      save.status === 'failed'
        ? '结果已完整暂存，但保存到项目失败；请重试保存，不需要重新生成'
        : null;
    if (
      job.phase !== nextPhase ||
      job.saveJobId !== save.id ||
      job.error !== nextError
    ) {
      job.saveJobId = save.id;
      job.candidateAssetId = save.id;
      job.resultSha256 = save.sha256;
      job.resultSize = save.size;
      job.phase = nextPhase;
      job.error = nextError;
      this.put(job);
    }
    return job;
  }
  private async download(job: ArkStoredJob, signal: AbortSignal) {
    job = this.syncSave(job);
    if (
      job.saveJobId &&
      ['saving', 'save_failed', 'candidate', 'adopted'].includes(job.phase)
    )
      return;
    if (!job.resultUrl) throw new Error('原任务尚未提供下载结果');
    if (job.locallyStopped || this.closed) return;
    job.phase = 'downloading';
    job.error = null;
    job.downloadAttempt++;
    job.resultKey = `ark:${job.id}:download:${job.downloadAttempt}`;
    this.put(job);
    try {
      const downloaded = await this.transport.download(
        job.resultUrl,
        job.kind,
        signal,
      );
      const saved = await this.options.staging.receive(
        {
          projectId: job.projectId,
          resultKey: job.resultKey,
          name: `${job.kind === 'image' ? '方舟图片' : '方舟视频'}-${job.id.slice(0, 8)}.${downloaded.extension}`,
          kind: job.kind,
          usage: 'reference',
          extension: downloaded.extension,
        },
        downloaded.stream,
        { signal },
      );
      if (
        !saved.sha256 ||
        !saved.size ||
        !['ready', 'saving', 'saved', 'failed'].includes(saved.status)
      )
        throw new Error();
      job.saveJobId = saved.id;
      job.candidateAssetId = saved.id;
      job.resultSha256 = saved.sha256;
      job.resultSize = saved.size;
      job.phase = saved.status === 'saved' ? 'candidate' : 'saving';
      job.error = null;
      this.put(job);
      this.options.saves.kick();
    } catch {
      const synchronized = this.syncSave(job);
      if (!synchronized.saveJobId) {
        synchronized.phase = 'download_failed';
        synchronized.error = signal.aborted
          ? '本地下载已停止，云端任务未取消；可以继续下载原结果'
          : '结果下载失败、链接已过期或下载地址无法验证；已保留原任务，请重试下载。不会重新生成';
        this.put(synchronized);
      }
    }
  }
  async refresh(id: string): Promise<ArkGenerationJob> {
    const { journal, configuration } = this.ready();
    let job = this.syncSave(journal.get(id));
    if (resumableOriginalTask(job)) {
      // Explicit user query only. Do not recreate any old intake/save records.
      configuration.key();
      await this.active.get(id)?.done;
      job = this.syncSave(journal.get(id));
      if (resumableOriginalTask(job)) {
        const project = await this.options.projects.open(job.projectId);
        this.ready();
        if (project.project.id !== job.projectId)
          throw new Error('原任务所属项目身份无法确认，未查询或下载');
        // Another query/recovery may have completed while project verification awaited.
        job = this.syncSave(journal.get(id));
        if (resumableOriginalTask(job)) {
          job.recoveryMarker = this.recoveryMarker();
          job.phase = 'queued';
          job.error = null;
          this.put(job);
        }
      }
    }
    if (
      !job.remoteTaskId ||
      !['queued', 'running', 'download_failed'].includes(job.phase)
    )
      return this.public(job);
    const apiKey = configuration.key();
    job.locallyStopped = false;
    this.put(job);
    this.clearTimer(id);
    await this.run(id, async (signal) => {
      job = journal.get(id);
      if (!job.remoteTaskId) return;
      try {
        const result = await this.transport.getVideo(
          job.remoteTaskId,
          apiKey,
          signal,
        );
        if (result.status === 'succeeded' && result.url) {
          job.resultUrl = result.url;
          job.resultReceivedAt = new Date().toISOString();
          job.phase = 'download_failed';
          job.error = null;
          this.put(job);
          if (!signal.aborted) await this.download(job, signal);
        } else {
          job.phase =
            result.status === 'succeeded' ? 'download_failed' : result.status;
          job.error = ['failed', 'expired'].includes(result.status)
            ? '方舟任务未成功完成；请在控制台查看原因和实际计费'
            : null;
          this.put(job);
          this.schedule(id);
        }
      } catch {
        job.error = signal.aborted
          ? '已停止本地查询，云端任务未取消'
          : '暂时无法查询原任务，已保留任务 ID；稍后继续查询，不会重新生成';
        this.put(job);
        if (!signal.aborted)
          this.schedule(
            id,
            Math.max(this.options.pollIntervalMs ?? 10000, 30000),
          );
      }
    });
    return this.public(this.syncSave(journal.get(id)));
  }
  async retryDownload(id: string): Promise<ArkGenerationJob> {
    const { journal } = this.ready();
    const job = this.syncSave(journal.get(id));
    if (job.phase !== 'download_failed') return this.public(job);
    job.locallyStopped = false;
    this.put(job);
    if (job.remoteTaskId) return this.refresh(id);
    await this.run(id, (signal) => this.download(job, signal));
    return this.public(this.syncSave(journal.get(id)));
  }
  async retrySave(id: string): Promise<ArkGenerationJob> {
    const { journal } = this.ready();
    const job = this.syncSave(journal.get(id));
    if (job.phase === 'recovery_blocked') {
      await this.reconcileRestoredResult(job);
      return this.public(journal.get(id));
    }
    if (
      job.phase !== 'save_failed' ||
      !job.saveJobId ||
      this.saveRetries.has(id)
    )
      return this.public(job);
    this.saveRetries.add(id);
    try {
      await this.options.saves.retry(job.saveJobId);
      return this.public(this.syncSave(journal.get(id)));
    } finally {
      this.saveRetries.delete(id);
    }
  }
  async stopLocal(id: string): Promise<ArkGenerationJob> {
    const { journal } = this.ready();
    this.clearTimer(id);
    const job = journal.get(id);
    job.locallyStopped = true;
    this.put(job);
    const active = this.active.get(id);
    active?.controller.abort();
    await active?.done;
    const current = journal.get(id);
    current.locallyStopped = true;
    this.put(current);
    return this.public(this.syncSave(current));
  }
  async cancelQueued(id: string): Promise<ArkGenerationJob> {
    this.ready().journal.get(id);
    // DELETE also deletes terminal records; checking queued then deleting races
    // with completion. Ark does not document a conditional cancellation API.
    throw new Error(
      '不能安全远端取消：方舟的取消接口也会删除已完成任务记录，排队状态可能同时变化。请到方舟控制台确认并操作；本地停止不会取消云端任务',
    );
  }
  async adopt(
    id: string,
    expectedRevision: number,
  ): Promise<ArkAdoptionResult> {
    const { journal } = this.ready();
    const job = this.syncSave(journal.get(id));
    if (!['candidate', 'adopted'].includes(job.phase) || !job.saveJobId)
      throw new Error('候选结果尚未保存完成，请先完成下载与保存');
    const saveJobId = job.saveJobId;
    return this.options.gate.run(async () => {
      this.ready();
      const opened = await this.options.references.acquire(
        job.projectId,
        saveJobId,
        job.kind,
      );
      if (!opened) throw new Error('候选文件无法验证，原记录已保留');
      try {
        const hash = createHash('sha256');
        let size = 0;
        const before = await opened.handle.stat();
        for await (const chunk of opened.handle.createReadStream({
          autoClose: false,
        })) {
          hash.update(chunk);
          size += chunk.length;
        }
        const after = await opened.handle.stat();
        if (
          size !== job.resultSize ||
          hash.digest('hex') !== job.resultSha256 ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new Error('候选文件已变化，未修改画布');
      } finally {
        await opened.handle.close();
      }
      const result = adoptArkResult(
        await this.options.projects.databasePath(job.projectId),
        this.options.projects.summary(job.projectId),
        job,
        expectedRevision,
      );
      this.options.store.putProject(result.snapshot.project);
      job.phase = 'adopted';
      job.adoptedShotId = result.shotId;
      job.error = null;
      this.put(job);
      return result;
    });
  }
  private async reconcileRestoredResult(job: ArkStoredJob) {
    try {
      const proof = await verifyArkCommittedResult(
        this.options.projects,
        this.options.references,
        job,
      );
      job.phase = proof.adoptedShotId ? 'adopted' : 'candidate';
      if (proof.adoptedShotId) job.adoptedShotId = proof.adoptedShotId;
      job.recoveryMarker = this.recoveryMarker();
      job.verifiedWithoutQueue = true;
      job.locallyStopped = false;
      job.error = null;
      this.put(job);
    } catch {
      job.phase = 'recovery_blocked';
      job.error = blockedRecovery;
      job.locallyStopped = true;
      this.put(job);
    }
  }
  /** Only known GET/download work resumes. An ambiguous POST never resumes. */
  async recover(): Promise<void> {
    if (!this.journal || this.initializationError) return;
    try {
      for (const stored of this.journal.list()) {
        if (stored.phase === 'submitting') {
          stored.phase = 'submission_unknown';
          stored.error = uncertain;
          this.put(stored);
        }
        const job = this.syncSave(stored);
        if (job.phase === 'downloading') {
          job.phase = 'download_failed';
          job.error = '上次下载被中断；可继续下载原结果，不会重新生成';
          this.put(job);
        }
        if (job.phase === 'recovery_blocked') {
          this.run(job.id, async () => {
            await this.reconcileRestoredResult(job);
          });
          continue;
        }
        if (job.locallyStopped) continue;
        if (job.remoteTaskId && ['queued', 'running'].includes(job.phase))
          this.schedule(job.id, 100);
        else if (job.phase === 'download_failed' && job.resultUrl)
          this.run(job.id, (signal) => this.download(job, signal));
      }
    } catch {
      this.initializationError = disabled;
      this.emit();
    }
  }
  async idle(): Promise<void> {
    while (this.active.size)
      await Promise.all([...this.active.values()].map((item) => item.done));
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.previews.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const item of this.active.values()) item.controller.abort();
    this.closing = this.idle().then(() => {
      this.journal?.close();
      this.journal = undefined;
    });
    return this.closing;
  }
}
