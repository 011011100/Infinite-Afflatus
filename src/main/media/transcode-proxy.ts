import { spawn } from 'node:child_process';
import type {
  MediaToolLocation,
  MediaToolPair,
} from '../../shared/media-tools';
import { assertMediaToolLaunch } from './media-tool-bundle';
import { mediaToolStartError, resolveMediaToolPair } from './media-tools';

export const PROXY_VERSION = 1;
export const MAX_PROXY_BYTES = 256 * 1024 * 1024;

function run(
  location: MediaToolLocation,
  args: string[],
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    assertMediaToolLaunch(location);
    const child = spawn(location.command, args, {
      shell: false,
      windowsHide: true,
      signal,
      timeout: 600_000,
    });
    let output = '';
    let diagnostic = '';
    let failure: Error | undefined;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output = (output + chunk).slice(-64_000);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      diagnostic = (diagnostic + chunk).slice(-2_000);
    });
    child.on('error', (error) => {
      failure = signal.aborted ? error : mediaToolStartError(location, error);
    });
    child.once('close', (code) => {
      if (failure) reject(failure);
      else if (code !== 0)
        reject(new Error(`媒体工具退出 (${code}): ${diagnostic}`));
      else resolve(output);
    });
  });
}

async function probe(
  file: string,
  signal: AbortSignal,
  location: MediaToolLocation,
) {
  const data = JSON.parse(
    await run(
      location,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,duration,start_time,avg_frame_rate:format=duration',
        '-of',
        'json',
        file,
      ],
      signal,
    ),
  ) as {
    streams: {
      width: number;
      height: number;
      duration?: string;
      start_time?: string;
      avg_frame_rate: string;
    }[];
    format: { duration: string };
  };
  const stream = data.streams[0];
  if (!stream) throw new Error('没有可预览的视频轨道');
  return {
    ...stream,
    duration: Number(stream.duration ?? data.format.duration),
    start: Number(stream.start_time ?? 0),
  };
}

/** Short GOP, no B-frames, original frame timing, no audio. Never transcodes the source in place. */
export async function transcodeProxy(
  input: string,
  output: string,
  signal: AbortSignal,
  tools: MediaToolPair = resolveMediaToolPair(),
): Promise<void> {
  const source = await probe(input, signal, tools.ffprobe);
  if (
    !Number.isFinite(source.duration) ||
    source.duration <= 0 ||
    Math.abs(source.start) > 0.05
  )
    throw new Error('当前素材时间戳不适合代理预览');
  await run(
    tools.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-threads',
      '2',
      '-i',
      input,
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      '-dn',
      '-map_metadata',
      '-1',
      '-vf',
      "scale=w='min(540,iw)':h='min(540,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '4',
      '-keyint_min',
      '4',
      '-sc_threshold',
      '0',
      '-bf',
      '0',
      '-threads',
      '2',
      '-fps_mode',
      'passthrough',
      '-movflags',
      '+faststart',
      '-fs',
      String(MAX_PROXY_BYTES),
      output,
    ],
    signal,
  );
  const proxy = await probe(output, signal, tools.ffprobe);
  if (
    !Number.isFinite(proxy.duration) ||
    !Number.isFinite(proxy.start) ||
    Math.abs(proxy.duration - source.duration) > 0.08 ||
    Math.abs(proxy.start - source.start) > 0.05
  )
    throw new Error('代理时间范围与原片不一致');
}
