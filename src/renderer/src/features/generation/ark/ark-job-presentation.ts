import type {
  ArkGenerationJob,
  ArkJobPhase,
} from '../../../../../shared/generation/ark-types';

export const arkPhaseLabel: Record<ArkJobPhase, string> = {
  submitting: '正在提交',
  submission_unknown: '提交结果不确定',
  queued: '云端排队中',
  running: '云端生成中',
  downloading: '正在下载结果',
  download_failed: '结果下载失败',
  saving: '正在保存候选',
  save_failed: '候选保存失败',
  recovery_blocked: '恢复后待核对结果',
  candidate: '候选已保存，待采纳',
  adopted: '已采纳',
  failed: '云端生成失败',
  cancelled: '云端已取消',
  expired: '任务或结果已过期',
};
export function arkJobActions(job: ArkGenerationJob) {
  const canQuery =
    !!job.remoteTaskId &&
    (['queued', 'running', 'submission_unknown'].includes(job.phase) ||
      (job.phase === 'recovery_blocked' && job.canResumeOriginalTask === true));
  return {
    query: canQuery,
    stop: canQuery && !job.locallyStopped,
    // Ark DELETE can erase a result if a queued task finishes during the request.
    cancel: false,
    download: job.phase === 'download_failed',
    save:
      job.phase === 'save_failed' ||
      (job.phase === 'recovery_blocked' && !canQuery),
    adopt: job.phase === 'candidate' && !!job.candidateAssetId,
  };
}
export function arkDuplicateRisk(jobs: ArkGenerationJob[]) {
  return jobs.some((job) => job.phase === 'submission_unknown');
}
