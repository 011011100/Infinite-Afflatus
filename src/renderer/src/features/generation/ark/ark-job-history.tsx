import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ArkGenerationJob } from '../../../../../shared/generation/ark-types';
import { mediaUrl } from '../../workspace/media';
import { arkJobActions, arkPhaseLabel } from './ark-job-presentation';
import { ArkRequestDetails } from './ark-request-details';

export function ArkJobHistory({
  jobs,
  busy,
  disabled,
  canAdopt,
  pendingAdoptionJobId,
  act,
  adopt,
}: {
  jobs: ArkGenerationJob[];
  busy: string | null;
  disabled: boolean;
  canAdopt: boolean;
  pendingAdoptionJobId: string | null;
  act: (id: string, action: () => Promise<unknown>) => Promise<void>;
  adopt: (id: string) => Promise<void>;
}) {
  return (
    <div className="space-y-4">
      {!jobs.length && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          这个生成组还没有任务。
        </p>
      )}
      {jobs.map((job) => (
        <ArkJobCard
          key={job.id}
          job={job}
          busy={busy}
          disabled={disabled}
          canAdopt={canAdopt}
          pendingAdoptionJobId={pendingAdoptionJobId}
          act={act}
          adopt={adopt}
        />
      ))}
    </div>
  );
}
function ArkJobCard({
  job,
  busy,
  disabled,
  canAdopt,
  pendingAdoptionJobId,
  act,
  adopt,
}: {
  job: ArkGenerationJob;
  busy: string | null;
  disabled: boolean;
  canAdopt: boolean;
  pendingAdoptionJobId: string | null;
  act: (id: string, action: () => Promise<unknown>) => Promise<void>;
  adopt: (id: string) => Promise<void>;
}) {
  const [showMedia, setShowMedia] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const actions = arkJobActions(job);
  return (
    <article
      className="space-y-3 rounded-xl border p-4"
      aria-label={`生成任务 ${job.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium" role="status">
            {arkPhaseLabel[job.phase]}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {job.capability} · {new Date(job.createdAt).toLocaleString()}
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          {job.kind === 'image' ? '图片' : '视频'}
        </span>
      </div>
      {job.error && (
        <p role="alert" className="break-words text-sm text-destructive">
          {job.error}
        </p>
      )}
      {job.phase === 'submission_unknown' && (
        <p className="rounded-lg bg-warning p-3 text-sm text-warning-foreground">
          没有可靠的提交回执，任务可能已在云端计费。不会自动重新生成；请先到方舟控制台核对，再决定是否新建任务。
        </p>
      )}
      {job.phase === 'download_failed' && (
        <p className="text-xs text-muted-foreground">
          生成已经完成。重试只下载这次结果，不再次生成或提交计费请求。云端结果链接通常仅保留
          24 小时。
        </p>
      )}
      {job.phase === 'save_failed' && (
        <p className="text-xs text-muted-foreground">
          已下载的结果保留在本机暂存区。重试只保存同一结果，不再次生成。
        </p>
      )}
      {job.phase === 'recovery_blocked' && (
        <p className="text-xs text-muted-foreground">
          应用恢复后，原保存记录需要重新核对。已有暂存文件保留；此操作只核对原结果，不自动下载、生成或创建新任务。
        </p>
      )}
      {job.phase === 'saving' && (
        <p className="text-xs text-muted-foreground">
          下载完成，等待写入项目；目录迁移期间保留在暂存区。
        </p>
      )}
      {(job.phase === 'queued' || job.phase === 'running') && (
        <p className="text-xs text-muted-foreground">
          {job.locallyStopped
            ? '本地跟踪已暂停，云端任务仍可能继续并产生费用。结果链接通常仅保留 24 小时；长时间暂停可能无法下载，请及时恢复查询。'
            : '收起此窗口不会停止云端任务。结果就绪后会尽快下载保存。'}
          {job.phase === 'running'
            ? ' 运行中的任务不能远程取消。'
            : ' 如需取消排队，请在火山方舟控制台核对任务状态后操作。本应用不会删除云端任务或结果。'}
        </p>
      )}
      {job.phase === 'candidate' && (
        <p className="text-xs text-muted-foreground">
          {job.kind === 'image'
            ? '采纳后添加到当前镜头素材，保留已有卡片与布局。'
            : '采纳后新建独立视频卡片，并复制提交时的镜头素材。已有组合、原视频和裁剪保持原样。'}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {actions.query && (
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() =>
              void act(job.id, () => window.desktop.refreshArkJob(job.id))
            }
          >
            {job.canResumeOriginalTask
              ? '查询原任务并接收结果'
              : job.locallyStopped
                ? '恢复结果查询'
                : '查询任务状态'}
          </Button>
        )}
        {actions.stop && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={() =>
              void act(job.id, () => window.desktop.stopArkPolling(job.id))
            }
          >
            暂停本地跟踪
          </Button>
        )}
        {actions.download && (
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() =>
              void act(job.id, () => window.desktop.retryArkDownload(job.id))
            }
          >
            重试下载结果
          </Button>
        )}
        {actions.save && (
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy || disabled}
            onClick={() =>
              void act(job.id, () => window.desktop.retryArkSave(job.id))
            }
          >
            {job.phase === 'recovery_blocked'
              ? '重新核对保存结果'
              : '重试保存候选'}
          </Button>
        )}
        {job.candidateAssetId && (
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => setShowMedia((value) => !value)}
          >
            {showMedia ? '收起候选预览' : '预览候选'}
          </Button>
        )}
        {actions.adopt && pendingAdoptionJobId !== job.id && (
          <Button
            size="sm"
            disabled={!!busy || disabled || !canAdopt}
            onClick={() => void adopt(job.id)}
          >
            {busy === `adopt:${job.id}`
              ? '正在采纳…'
              : job.kind === 'image'
                ? '采纳到镜头素材'
                : '采纳为新视频卡片'}
          </Button>
        )}
      </div>
      {showMedia && job.candidateAssetId && (
        <div className="rounded-lg bg-muted p-2">
          {job.kind === 'image' ? (
            <img
              className="max-h-72 w-full object-contain"
              src={mediaUrl(job.projectId, job.candidateAssetId)}
              alt="已保存的生成图片候选"
              onError={() => setMediaError(true)}
            />
          ) : (
            <video
              className="max-h-72 w-full"
              src={mediaUrl(job.projectId, job.candidateAssetId)}
              controls
              playsInline
              preload="metadata"
              onError={() => setMediaError(true)}
            >
              <track kind="captions" />
            </video>
          )}{' '}
          {mediaError && (
            <p role="alert" className="text-xs text-destructive">
              候选无法预览，请检查项目文件；不会重新生成。
            </p>
          )}
        </div>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          查看本次提交内容
        </summary>
        <div className="mt-3">
          <ArkRequestDetails request={job} />
          <p className="mt-3 break-all text-muted-foreground">
            本机任务：{job.id}
            {job.remoteTaskId && ` · 云端任务：${job.remoteTaskId}`}
          </p>
        </div>
      </details>
    </article>
  );
}
