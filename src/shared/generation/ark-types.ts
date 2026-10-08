import type { ProjectSnapshot } from '../models';
import type { GenerationParameters } from './draft';
import type { ImageGenerationParameters } from './image-generation';
import type { GenerationWorkspace } from './workspace-types';

export const ARK_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3';
export const ARK_PROFILES = [
  'seedream-5.0-lite',
  'seedream-4.5',
  'seedance-2.0',
  'seedance-2.0-fast',
] as const;
export type ArkCapabilityProfile = (typeof ARK_PROFILES)[number];
/** An endpoint ID must be explicitly associated with its actual model capability. */
export interface ArkModelBinding {
  alias: ArkCapabilityProfile;
  modelId: string;
  capability: ArkCapabilityProfile;
}
export interface ArkConfiguration {
  endpoint: typeof ARK_ENDPOINT;
  hasKey: boolean;
  secureStorageAvailable: boolean;
  models: ArkModelBinding[];
  error?: string;
}
export interface ArkConfigurationInput {
  models: ArkModelBinding[];
  /** Write-only IPC input. Never returned, logged or included in history. */
  apiKey?: string;
  clearKey?: boolean;
}
export interface ArkGenerationTarget {
  projectId: string;
  shotId: string;
  groupId: string;
}
export interface ArkReferenceSummary {
  nodeId: string;
  assetId: string;
  name: string;
  kind: 'image' | 'video' | 'audio' | 'text';
  bytes: number;
  sha256: string;
  role?: 'reference_image' | 'reference_audio' | 'reference_video';
}
export interface ArkRequestSummary extends ArkGenerationTarget {
  kind: 'image' | 'video';
  modelId: string;
  capability: ArkCapabilityProfile;
  prompt: string;
  parameters: GenerationParameters | ImageGenerationParameters;
  references: ArkReferenceSummary[];
  /** Exact computed wire size for images, not a guessed provider alias. */
  imageSize?: string;
}
export interface ArkGenerationPreview extends ArkRequestSummary {
  token: string;
  expiresAt: string;
  transmissionNotice: string;
  costNotice: string;
  warnings: string[];
}
export type ArkJobPhase =
  | 'submitting'
  | 'submission_unknown'
  | 'queued'
  | 'running'
  | 'downloading'
  | 'download_failed'
  | 'saving'
  | 'save_failed'
  | 'recovery_blocked'
  | 'candidate'
  | 'adopted'
  | 'failed'
  | 'cancelled'
  | 'expired';
export interface ArkGenerationJob extends ArkRequestSummary {
  id: string;
  phase: ArkJobPhase;
  createdAt: string;
  updatedAt: string;
  remoteTaskId?: string;
  /** Local pause does not cancel the remote task or promise a refund. */
  locallyStopped: boolean;
  /** Main-process proof: explicit query can resume this pre-result remote task after index restore. */
  canResumeOriginalTask?: boolean;
  saveJobId?: string;
  candidateAssetId?: string;
  adoptedShotId?: string;
  error: string | null;
}
export interface ArkAdoptionResult {
  jobId: string;
  assetId: string;
  shotId: string;
  kind: 'image' | 'video';
  sourceShotId: string;
  baselineRevision: number;
  committedRevision: number;
  snapshot: ProjectSnapshot;
  workspace: GenerationWorkspace;
}

export interface ArkGenerationApi {
  getArkConfig(): Promise<ArkConfiguration>;
  saveArkConfig(input: ArkConfigurationInput): Promise<ArkConfiguration>;
  previewArkGeneration(
    target: ArkGenerationTarget,
  ): Promise<ArkGenerationPreview>;
  submitArkGeneration(token: string): Promise<ArkGenerationJob>;
  cancelArkPreview(token?: string): Promise<void>;
  onArkJobsChanged(listener: () => void): () => void;
  listArkJobs(
    projectId: string,
    shotId?: string,
    groupId?: string,
  ): Promise<ArkGenerationJob[]>;
  refreshArkJob(jobId: string): Promise<ArkGenerationJob>;
  retryArkDownload(jobId: string): Promise<ArkGenerationJob>;
  retryArkSave(jobId: string): Promise<ArkGenerationJob>;
  stopArkPolling(jobId: string): Promise<ArkGenerationJob>;
  cancelArkQueued(jobId: string): Promise<ArkGenerationJob>;
  adoptArkJob(
    jobId: string,
    expectedWorkspaceRevision: number,
  ): Promise<ArkAdoptionResult>;
}
