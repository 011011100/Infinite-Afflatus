/** MP4 uses H.264 video, AAC stereo audio, and the first clip's display aspect ratio. */
export interface SequenceExportOptions {
  resolution: '720p' | '1080p';
  frameRate: 24 | 25 | 30 | 60;
}

export const DEFAULT_EXPORT_OPTIONS: SequenceExportOptions = {
  resolution: '1080p',
  frameRate: 30,
};

export type SequenceExportStatus =
  | 'queued'
  | 'preparing'
  | 'encoding'
  | 'finalizing'
  | 'completed'
  | 'cancelled'
  | 'failed';

export interface SequenceExportJob {
  id: string;
  projectId: string;
  cardId: string;
  projectName: string;
  outputPath: string;
  status: SequenceExportStatus;
  /** Actual copy/encode progress; 1 is reserved for a published, verified file. */
  progress: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  clipCount: number;
  duration: number;
  options: SequenceExportOptions;
}

export type ExportJob = SequenceExportJob;

export function exportIsActive(job: SequenceExportJob): boolean {
  return ['queued', 'preparing', 'encoding', 'finalizing'].includes(job.status);
}

export function validateExportOptions(input: unknown): SequenceExportOptions {
  if (input === undefined) return { ...DEFAULT_EXPORT_OPTIONS };
  if (!input || typeof input !== 'object') throw new Error('导出设置无效');
  const options = input as SequenceExportOptions;
  if (
    !['720p', '1080p'].includes(options.resolution) ||
    ![24, 25, 30, 60].includes(options.frameRate)
  )
    throw new Error('导出设置无效');
  return { resolution: options.resolution, frameRate: options.frameRate };
}
