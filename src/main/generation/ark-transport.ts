import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { ARK_ENDPOINT } from '../../shared/generation/ark-types';
import { imageInfo } from './ark-media';

export type ArkRemoteState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired';
export interface ArkRemoteTask {
  status: ArkRemoteState;
  url?: string;
}
export interface ArkDownload {
  stream: Readable;
  extension: string;
}
export interface ArkTransport {
  createImage(
    body: Record<string, unknown>,
    key: string,
    signal: AbortSignal,
  ): Promise<{ url: string }>;
  createVideo(
    body: Record<string, unknown>,
    key: string,
    signal: AbortSignal,
  ): Promise<{ id: string }>;
  getVideo(
    id: string,
    key: string,
    signal: AbortSignal,
  ): Promise<ArkRemoteTask>;
  download(
    url: string,
    kind: 'image' | 'video',
    signal: AbortSignal,
  ): Promise<ArkDownload>;
}
export class ArkRequestError extends Error {
  constructor(
    message: string,
    readonly submissionUnknown: boolean,
  ) {
    super(message);
  }
}
const safeTaskId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** No retry here: the provider does not document an idempotency key for POST. */
export class ArkHttpTransport implements ArkTransport {
  constructor(private readonly apiFetch: typeof fetch = fetch) {}
  private async api(
    path: string,
    key: string,
    signal: AbortSignal,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const submitted = body !== undefined;
    try {
      const response = await this.apiFetch(`${ARK_ENDPOINT}${path}`, {
        method: submitted ? 'POST' : 'GET',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        ...(submitted ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(submitted ? 180000 : 30000),
        ]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ArkRequestError(
          `方舟请求失败（HTTP ${response.status}）；请检查账户权限、配额或稍后查询原任务`,
          submitted &&
            !(
              response.status >= 400 &&
              response.status < 500 &&
              response.status !== 408
            ),
        );
      }
      if (!response.body) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error();
        chunks.push(chunk);
      }
      return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch (error) {
      if (error instanceof ArkRequestError) throw error;
      throw new ArkRequestError(
        submitted
          ? '未能确认方舟是否接受本次提交；为避免重复计费，不会自动重发。请核对方舟控制台'
          : '暂时无法查询方舟任务；已保留任务 ID，可稍后继续查询',
        submitted,
      );
    }
  }
  async createImage(
    body: Record<string, unknown>,
    key: string,
    signal: AbortSignal,
  ) {
    const response = await this.api('/images/generations', key, signal, body);
    const items = Array.isArray(response.data) ? response.data : [];
    const item = record(items[0]);
    if (items.length !== 1 || typeof item.url !== 'string' || item.error)
      throw new ArkRequestError(
        '图片请求已返回，但结果无法确认；不会自动重新生成，请核对方舟控制台',
        true,
      );
    return { url: item.url };
  }
  async createVideo(
    body: Record<string, unknown>,
    key: string,
    signal: AbortSignal,
  ) {
    const response = await this.api(
      '/contents/generations/tasks',
      key,
      signal,
      body,
    );
    if (!safeTaskId(response.id))
      throw new ArkRequestError(
        '方舟未返回可验证的任务 ID；不会自动重新生成，请核对控制台',
        true,
      );
    return { id: response.id };
  }
  async getVideo(
    id: string,
    key: string,
    signal: AbortSignal,
  ): Promise<ArkRemoteTask> {
    if (!safeTaskId(id)) throw new Error('远端任务 ID 无效');
    const response = await this.api(
      `/contents/generations/tasks/${encodeURIComponent(id)}`,
      key,
      signal,
    );
    const states: ArkRemoteState[] = [
      'queued',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'expired',
    ];
    if (
      response.id !== id ||
      !states.includes(response.status as ArkRemoteState)
    )
      throw new Error('方舟任务响应无法验证，已保留原任务');
    const status = response.status as ArkRemoteState;
    const url = record(response.content).video_url;
    if (status === 'succeeded' && typeof url !== 'string')
      throw new Error('任务已成功但结果地址尚无法验证，请稍后查询原任务');
    return { status, ...(typeof url === 'string' ? { url } : {}) };
  }
  download(
    url: string,
    kind: 'image' | 'video',
    signal: AbortSignal,
  ): Promise<ArkDownload> {
    return downloadArkResult(url, kind, signal);
  }
}

export function validateArkDownloadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('结果下载地址无效');
  }
  // Only Ark's documented Beijing result buckets. New provider hosts fail closed
  // and can be added after verification; arbitrary user/TOS buckets are not accepted.
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    url.hash ||
    !/^ark-content-generation(?:-v[0-9]+)?-cn-beijing\.tos-cn-beijing\.volces\.com$/.test(
      url.hostname,
    )
  )
    throw new Error(
      '结果地址不在受信任的方舟下载域名内，已保留任务；需要核对服务商地址',
    );
  return url;
}
export function publicIPv4(value: string): boolean {
  const parts = value.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((item) => !Number.isInteger(item) || item < 0 || item > 255)
  )
    return false;
  const [a = 0, b = 0, c = 0] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}
async function downloadArkResult(
  value: string,
  kind: 'image' | 'video',
  signal: AbortSignal,
  redirects = 0,
): Promise<ArkDownload> {
  const url = validateArkDownloadUrl(value);
  signal.throwIfAborted();
  const addresses = await lookup(url.hostname, { all: true, family: 4 });
  if (
    !addresses.length ||
    addresses.some((entry) => !publicIPv4(entry.address))
  )
    throw new Error('结果服务器的网络地址不安全，下载未开始');
  const address = addresses[0];
  if (!address) throw new Error('结果服务器无法解析');
  const response = await new Promise<import('node:http').IncomingMessage>(
    (resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          method: 'GET',
          family: 4,
          signal,
          lookup: (_host, _options, callback) =>
            callback(null, address.address, 4),
          headers: {
            Accept:
              kind === 'image'
                ? 'image/png,image/jpeg,image/webp'
                : 'video/mp4',
          },
        },
        resolve,
      );
      request.setTimeout(60000, () =>
        request.destroy(new Error('结果下载超时')),
      );
      request.once('error', () =>
        reject(new Error('结果下载连接中断，可重试下载原结果')),
      );
      request.end();
    },
  );
  if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
    response.destroy();
    if (redirects >= 2 || !response.headers.location)
      throw new Error('结果下载重定向无法验证');
    return downloadArkResult(
      new URL(response.headers.location, url).href,
      kind,
      signal,
      redirects + 1,
    );
  }
  const mime = response.headers['content-type']
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  const formats =
    kind === 'image'
      ? { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
      : { 'video/mp4': 'mp4', 'application/octet-stream': 'mp4' };
  const extension = mime ? formats[mime as keyof typeof formats] : undefined;
  const maximum = kind === 'image' ? 40 * 1024 * 1024 : 1024 ** 3;
  const lengthHeader = response.headers['content-length'];
  const expected =
    lengthHeader === undefined ? undefined : Number(lengthHeader);
  if (
    response.statusCode !== 200 ||
    !extension ||
    response.headers['content-encoding'] ||
    (expected !== undefined &&
      (!Number.isSafeInteger(expected) || expected < 1 || expected > maximum))
  ) {
    response.destroy();
    throw new Error('结果已过期、格式不支持或文件过大；可重试查询与下载原任务');
  }
  const stream = Readable.from(
    (async function* () {
      let bytes = 0;
      let checked = false;
      let prefix = Buffer.alloc(0);
      try {
        for await (const chunk of response) {
          signal.throwIfAborted();
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += data.length;
          if (bytes > maximum) throw new Error();
          if (!checked) {
            prefix = Buffer.concat([prefix, data]);
            if (
              prefix.length < 65536 &&
              (expected === undefined || bytes < expected)
            )
              continue;
            verifyResultPrefix(prefix, kind, extension);
            checked = true;
            yield prefix;
          } else yield data;
        }
        if (!checked) {
          verifyResultPrefix(prefix, kind, extension);
          yield prefix;
        }
        if (!bytes || (expected !== undefined && bytes !== expected))
          throw new Error();
      } catch {
        throw new Error(
          '结果下载未完成或媒体格式无法验证；原任务已保留，可重试下载',
        );
      } finally {
        response.destroy();
      }
    })(),
  );
  // A response can error before the staging consumer begins iteration.
  response.on('error', () => undefined);
  return { stream, extension };
}
function verifyResultPrefix(
  bytes: Buffer,
  kind: 'image' | 'video',
  extension: string,
) {
  if (kind === 'image') {
    const info = imageInfo(bytes);
    if (
      info.extension !== extension ||
      !info.width ||
      !info.height ||
      info.width * info.height > 40000000
    )
      throw new Error('结果图片格式不匹配');
  } else if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp')
    throw new Error('结果视频不是 MP4');
}
