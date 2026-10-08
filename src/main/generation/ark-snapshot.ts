import { createHash } from 'node:crypto';
import type {
  ArkGenerationTarget,
  ArkModelBinding,
  ArkRequestSummary,
} from '../../shared/generation/ark-types';
import { MAX_PROMPT_LENGTH } from '../../shared/generation/draft';
import type { ImageGenerationParameters } from '../../shared/generation/image-generation';
import type {
  GenerationWorkspace,
  ShotWorkspace,
} from '../../shared/generation/workspace-types';
import type { ProjectService } from '../projects/project-service';
import type { ProjectReferenceReader } from '../saving/project-reference-reader';
import type { AppStore } from '../storage/app-store';
import { imageInfo, wavDuration } from './ark-media';

export interface ArkSnapshotSources {
  projects: Pick<ProjectService, 'open'>;
  store: Pick<AppStore, 'jobs'>;
  readWorkspace(projectId: string): Promise<GenerationWorkspace>;
  references: Pick<ProjectReferenceReader, 'acquire'>;
}
export interface ArkSnapshot {
  summary: ArkRequestSummary;
  shotContext: ShotWorkspace;
  request: Record<string, unknown>;
  hash: string;
}
const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const MB = 1024 * 1024;
const dimensions: Record<string, Record<string, string>> = {
  '2K': {
    '1:1': '2048x2048',
    '4:3': '2304x1728',
    '3:4': '1728x2304',
    '16:9': '2848x1600',
    '9:16': '1600x2848',
    '3:2': '2496x1664',
    '2:3': '1664x2496',
    '21:9': '3136x1344',
  },
  '3K': {
    '1:1': '3072x3072',
    '4:3': '3456x2592',
    '3:4': '2592x3456',
    '16:9': '4096x2304',
    '9:16': '2304x4096',
    '3:2': '3744x2496',
    '2:3': '2496x3744',
    '21:9': '4704x2016',
  },
  '4K': {
    '1:1': '4096x4096',
    '4:3': '4704x3520',
    '3:4': '3520x4704',
    '16:9': '5504x3040',
    '9:16': '3040x5504',
    '3:2': '4992x3328',
    '2:3': '3328x4992',
    '21:9': '6240x2656',
  },
};
export function arkImageSize(parameters: ImageGenerationParameters): string {
  if (parameters.model === 'seedream-4.5' && parameters.resolution === '3K')
    throw new Error('Seedream 4.5 不支持 3K');
  if (parameters.ratio === 'adaptive') return parameters.resolution;
  const size = dimensions[parameters.resolution]?.[parameters.ratio];
  if (!size) throw new Error('图片宽高比或分辨率不受支持');
  const [width = 0, height = 0] = size.split('x').map(Number);
  if (
    width * height < 3686400 ||
    width * height > 16777216 ||
    width / height < 1 / 16 ||
    width / height > 16
  )
    throw new Error('图片像素数量或宽高比超出所选模型限制');
  return size;
}

/** A preview and its confirmation each read and hash the actual owned bytes. */
export async function snapshotArkRequest(
  target: ArkGenerationTarget,
  binding: ArkModelBinding,
  sources: ArkSnapshotSources,
  signal?: AbortSignal,
): Promise<ArkSnapshot> {
  const workspace = await sources.readWorkspace(target.projectId);
  const shot = workspace.shots.find((item) => item.id === target.shotId);
  const group = shot?.groups.find((item) => item.id === target.groupId);
  if (!shot || !group) throw new Error('生成组已移除，请重新打开镜头');
  if (
    group.parameters.model !== binding.alias ||
    binding.capability !== binding.alias
  )
    throw new Error('模型设置已变化，请重新检查');
  const kind = group.kind === 'image' ? 'image' : 'video';
  const snapshot = await sources.projects.open(target.projectId);
  const available = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
  for (const job of sources.store.jobs()) {
    if (
      job.projectId === target.projectId &&
      job.usage === 'reference' &&
      job.sha256 &&
      !available.has(job.id)
    )
      available.set(job.id, {
        id: job.id,
        name: job.name,
        kind: job.kind,
        size: job.size,
        sha256: job.sha256,
        usage: 'reference',
        relativePath: '',
      });
  }
  const summary: ArkRequestSummary = {
    projectId: target.projectId,
    shotId: target.shotId,
    groupId: target.groupId,
    kind,
    modelId: binding.modelId,
    capability: binding.capability,
    prompt: '',
    parameters: structuredClone(group.parameters),
    references: [],
  };
  const text: string[] = [];
  const images: string[] = [];
  const audio: string[] = [];
  let audioDuration = 0;
  let bodyBytes = 0;
  for (const node of shot.nodes.filter((item) => item.groupId === group.id)) {
    signal?.throwIfAborted();
    if (node.type === 'text') {
      text.push(node.text);
      continue;
    }
    const asset = available.get(node.assetId);
    if (!asset) throw new Error('参考素材不存在或尚未完整暂存');
    if (kind === 'image' && !['text', 'image'].includes(asset.kind))
      throw new Error('图片生成仅支持文本和图片参考');
    if (asset.kind === 'video')
      throw new Error(
        '本地视频参考尚不能安全提交：方舟需要公网 URL 或 asset:// 素材 ID，当前未配置上传通道；未发送任何素材',
      );
    let bytes: Buffer;
    if (asset.kind === 'text' && node.textOverride !== undefined)
      bytes = Buffer.from(node.textOverride, 'utf8');
    else {
      const media = await sources.references.acquire(
        target.projectId,
        asset.id,
        asset.kind,
        signal,
      );
      if (!media) throw new Error('参考素材无法验证，请先完成素材检查');
      try {
        const before = await media.handle.stat();
        const maximum =
          asset.kind === 'text'
            ? MB
            : asset.kind === 'audio'
              ? 15 * MB
              : 30 * MB;
        if (
          !before.isFile() ||
          before.size < 1 ||
          before.size > maximum ||
          (kind === 'video' && asset.kind === 'image' && before.size >= maximum)
        )
          throw new Error('参考素材为空或超出方舟大小限制');
        bytes = await media.handle.readFile();
        const after = await media.handle.stat();
        if (
          before.size !== bytes.length ||
          after.size !== before.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          digest(bytes) !== asset.sha256
        )
          throw new Error('参考素材内容已变化，请先完成素材检查');
      } finally {
        await media.handle.close();
      }
    }
    const reference = {
      nodeId: node.id,
      assetId: asset.id,
      name: node.name ?? asset.name,
      kind: asset.kind,
      bytes: bytes.length,
      sha256: digest(bytes),
    };
    if (asset.kind === 'text') {
      try {
        text.push(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        throw new Error('文本参考必须使用 UTF-8 编码');
      }
      summary.references.push(reference);
    } else if (asset.kind === 'image') {
      const info = imageInfo(bytes);
      const ratio = info.width / info.height;
      if (
        !Number.isFinite(ratio) ||
        (kind === 'image'
          ? info.width < 15 ||
            info.height < 15 ||
            info.width * info.height > 36000000 ||
            ratio < 1 / 16 ||
            ratio > 16
          : info.width < 300 ||
            info.height < 300 ||
            info.width > 6000 ||
            info.height > 6000 ||
            ratio < 0.4 ||
            ratio > 2.5)
      )
        throw new Error('参考图片尺寸或宽高比超出所选模型限制');
      images.push(`data:${info.mime};base64,${bytes.toString('base64')}`);
      summary.references.push({
        ...reference,
        ...(kind === 'video' ? { role: 'reference_image' as const } : {}),
      });
    } else {
      const duration = wavDuration(bytes);
      if (duration < 2 || duration > 15)
        throw new Error('Seedance 2.0 每段音频必须为 2–15 秒');
      audioDuration += duration;
      audio.push(`data:audio/wav;base64,${bytes.toString('base64')}`);
      summary.references.push({ ...reference, role: 'reference_audio' });
    }
    bodyBytes += Math.ceil(bytes.length / 3) * 4;
    if (bodyBytes > 60 * MB)
      throw new Error('参考素材编码后的请求过大，请减少素材或压缩后重试');
  }
  summary.prompt = text.filter((item) => item.trim()).join('\n\n');
  if (!summary.prompt.trim() || summary.prompt.length > MAX_PROMPT_LENGTH)
    throw new Error(`请输入有效提示词，合并后最多 ${MAX_PROMPT_LENGTH} 个字符`);
  if (
    images.length > (kind === 'image' ? 14 : 9) ||
    audio.length > 3 ||
    audioDuration > 15 ||
    images.length + audio.length > 15
  )
    throw new Error('参考数量或音频总时长超出所选模型限制');
  if (audio.length && !images.length)
    throw new Error('音频参考需要同时提供图片或视频参考；当前可添加图片后重试');
  let request: Record<string, unknown>;
  if (group.kind === 'image') {
    summary.imageSize = arkImageSize(group.parameters);
    request = {
      model: binding.modelId,
      prompt: summary.prompt,
      size: summary.imageSize,
      sequential_image_generation: 'disabled',
      response_format: 'url',
      stream: false,
      watermark: true,
      ...(images.length ? { image: images } : {}),
    };
  } else {
    const p = group.parameters;
    if (
      !Number.isInteger(p.duration) ||
      (p.duration !== -1 && (p.duration < 4 || p.duration > 15)) ||
      (p.model === 'seedance-2.0-fast' && p.resolution === '1080p')
    )
      throw new Error('视频时长或分辨率超出所选模型能力');
    request = {
      model: binding.modelId,
      content: [
        { type: 'text', text: summary.prompt },
        ...images.map((url) => ({
          type: 'image_url',
          image_url: { url },
          role: 'reference_image',
        })),
        ...audio.map((url) => ({
          type: 'audio_url',
          audio_url: { url },
          role: 'reference_audio',
        })),
      ],
      ratio: p.ratio,
      resolution: p.resolution,
      duration: p.duration,
      generate_audio: p.generateAudio,
      watermark: true,
    };
  }
  if (Buffer.byteLength(JSON.stringify(request)) > 64 * MB)
    throw new Error('生成请求超过 64 MB，请减少参考素材');
  const current = (await sources.readWorkspace(target.projectId)).shots.find(
    (item) => item.id === target.shotId,
  );
  if (JSON.stringify(current) !== JSON.stringify(shot))
    throw new Error('镜头内容在检查期间发生变化，请重新检查');
  return {
    summary,
    shotContext: structuredClone(shot),
    request,
    hash: digest(JSON.stringify({ summary, shot })),
  };
}
