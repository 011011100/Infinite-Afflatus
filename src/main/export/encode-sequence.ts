import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { ClipTrim } from '../../shared/canvas/trim';
import type { SequenceExportOptions } from '../../shared/export';
import type { ExportWork } from './export-work';
import type { ExportMedia } from './media-probe';
import { mediaProcess } from './media-process';

export interface ExportClip {
  file: string;
  range: ClipTrim;
  media: ExportMedia;
}

const prefix = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-nostdin',
  '-y',
  '-nostats',
  '-stats_period',
  '0.2',
  '-progress',
  'pipe:1',
];

/** One decoder/encoder at a time keeps large combinations bounded in memory. */
export async function encodeSequence(
  clips: ExportClip[],
  size: { width: number; height: number },
  options: SequenceExportOptions,
  work: ExportWork,
  signal: AbortSignal,
  progress: (fraction: number, finalizing: boolean) => void,
): Promise<string> {
  const executable = process.env.FFMPEG_PATH || 'ffmpeg';
  const total = clips.reduce(
    (sum, clip) => sum + clip.range.end - clip.range.start,
    0,
  );
  const segments: string[] = [];
  let elapsed = 0;
  for (const clip of clips) {
    signal.throwIfAborted();
    const duration = clip.range.end - clip.range.start;
    const segment = await work.create('mkv');
    const args = [
      ...prefix,
      '-threads',
      '2',
      '-ss',
      String(clip.range.start),
      '-protocol_whitelist',
      'file,pipe',
      '-format_whitelist',
      'mov,matroska,webm',
      '-i',
      clip.file,
    ];
    if (!clip.media.hasAudio)
      args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    args.push(
      '-map',
      '0:V:0',
      '-map',
      clip.media.hasAudio ? '0:a:0' : '1:a:0',
      '-sn',
      '-dn',
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-vf',
      [
        `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1`,
        `pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
        'setsar=1',
        `fps=${options.frameRate}`,
        'setpts=PTS-STARTPTS',
      ].join(','),
      '-af',
      'aresample=48000:async=1:first_pts=0,apad,asetpts=PTS-STARTPTS',
      '-t',
      String(duration),
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '2',
      '-c:a',
      'pcm_s16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-f',
      'matroska',
      segment,
    );
    await mediaProcess(executable, args, signal, (seconds) => {
      progress((0.9 * (elapsed + Math.min(seconds, duration))) / total, false);
    });
    segments.push(segment);
    elapsed += duration;
    progress((0.9 * elapsed) / total, false);
  }
  const list = await work.create('txt');
  // Generated UUID names only; user filenames never become concat syntax.
  await writeFile(
    list,
    segments.map((file) => `file '${basename(file)}'`).join('\n'),
  );
  const output = await work.create('mp4');
  progress(0.9, true);
  await mediaProcess(
    executable,
    [
      ...prefix,
      '-f',
      'concat',
      '-safe',
      '1',
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      list,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-af',
      'aresample=48000:async=1:first_pts=0',
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      output,
    ],
    signal,
    (seconds) => progress(0.9 + 0.1 * Math.min(1, seconds / total), true),
  );
  return output;
}
