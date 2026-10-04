import type { SequenceExportOptions } from '../../shared/export';
import { resolveMediaTool } from '../media/media-tools';
import { mediaProcess } from './media-process';

export interface ExportMedia {
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

interface ProbeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  duration?: string;
  sample_aspect_ratio?: string;
  disposition?: { attached_pic?: number };
  side_data_list?: { rotation?: number }[];
  color_transfer?: string;
}

export async function probeExportMedia(
  file: string,
  signal: AbortSignal,
): Promise<ExportMedia> {
  const result = JSON.parse(
    await mediaProcess(
      resolveMediaTool('ffprobe'),
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-format_whitelist',
        'mov,matroska,webm',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        file,
      ],
      signal,
    ),
  ) as { streams?: ProbeStream[]; format?: { duration?: string } };
  const streams = result.streams ?? [];
  const video = streams.find(
    (stream) =>
      stream.codec_type === 'video' && !stream.disposition?.attached_pic,
  );
  if (!video) throw new Error('素材没有可导出的视频轨道');
  const duration = Number(video.duration ?? result.format?.duration);
  const sar = (video.sample_aspect_ratio ?? '1:1').split(':').map(Number);
  const ratio = sar[0] && sar[1] ? sar[0] / sar[1] : 1;
  let width = Number(video.width) * ratio;
  let height = Number(video.height);
  const rotation =
    video.side_data_list?.find((item) => item.rotation !== undefined)
      ?.rotation ?? 0;
  if (Math.abs(rotation % 180) === 90) [width, height] = [height, width];
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 2 ||
    height < 2 ||
    width > 32768 ||
    height > 32768
  )
    throw new Error('素材时长或画面尺寸无效');
  // SDR conversion needs explicit tone mapping; do not silently wash out HDR media.
  if (['smpte2084', 'arib-std-b67'].includes(video.color_transfer ?? ''))
    throw new Error('当前导出暂不支持 HDR 素材，请先转换为 SDR 视频');
  return {
    duration,
    width,
    height,
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
  };
}

/** Long edge limit, square pixels, even dimensions; never upscale the first clip. */
export function exportDimensions(
  source: Pick<ExportMedia, 'width' | 'height'>,
  options: SequenceExportOptions,
): { width: number; height: number } {
  const limit = options.resolution === '720p' ? 1280 : 1920;
  const scale = Math.min(1, limit / Math.max(source.width, source.height));
  return {
    width: Math.max(2, Math.floor((source.width * scale) / 2) * 2),
    height: Math.max(2, Math.floor((source.height * scale) / 2) * 2),
  };
}
