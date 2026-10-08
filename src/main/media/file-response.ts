import { constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';

export interface OpenedMediaFile {
  handle: FileHandle;
  filename: string;
}

type ByteRange = { start: number; end: number };

/** Single byte ranges used by Chromium for metadata, playback and seeking. */
function byteRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start >= size ||
    end < start
  )
    return null;
  return { start, end: Math.min(end, size - 1) };
}

const contentTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/** Serve authorized bytes; takes ownership of an open descriptor, even on failure. */
export async function mediaFileResponse(
  file: string | OpenedMediaFile,
  request: Request,
  onClosed?: () => void,
): Promise<Response> {
  let handle: FileHandle | undefined;
  let streaming = false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    onClosed?.();
  };
  try {
    handle =
      typeof file === 'string'
        ? await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
        : file.handle;
    const filename = typeof file === 'string' ? file : file.filename;
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('媒体不是普通文件');
    const { size } = info;
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Content-Type':
        contentTypes[extname(filename).toLowerCase()] ??
        'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    // HEAD describes the full resource; Range only applies to GET.
    const requested =
      request.method === 'GET' ? request.headers.get('range') : null;
    const range = requested ? byteRange(requested, size) : null;
    if (requested && !range) {
      headers.set('Content-Range', `bytes */${size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set(
      'Content-Length',
      String(range ? range.end - range.start + 1 : size),
    );
    if (range)
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    const status = range ? 206 : 200;
    if (request.method === 'HEAD' || size === 0)
      return new Response(null, { status, headers });

    request.signal.throwIfAborted();
    const stream = handle.createReadStream({
      start: range?.start ?? 0,
      end: range?.end,
      autoClose: true,
      signal: request.signal,
    });
    stream.once('close', release);
    streaming = true;
    // The web stream also closes the file when Chromium cancels an old seek.
    const body = Readable.toWeb(stream, {
      strategy: {
        highWaterMark: 64 * 1024,
        size: (chunk: Uint8Array) => chunk.byteLength,
      },
    }) as ReadableStream<Uint8Array>;
    return new Response(body, { status, headers });
  } finally {
    if (!streaming) {
      try {
        await handle?.close();
      } finally {
        release();
      }
    }
  }
}
