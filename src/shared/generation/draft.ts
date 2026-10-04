/** Local editing contract; provider request construction belongs to a later adapter. */
export const GENERATION_MODELS = ['seedance-2.0', 'seedance-2.0-fast'] as const;
export const GENERATION_RATIOS = [
  'adaptive',
  '16:9',
  '9:16',
  '1:1',
  '4:3',
  '3:4',
  '21:9',
] as const;
export const GENERATION_RESOLUTIONS = ['480p', '720p', '1080p'] as const;
export const MAX_PROMPT_LENGTH = 10000;
export const MAX_REFERENCES = 24;

export interface GenerationParameters {
  model: (typeof GENERATION_MODELS)[number];
  ratio: (typeof GENERATION_RATIOS)[number];
  resolution: (typeof GENERATION_RESOLUTIONS)[number];
  duration: number;
  generateAudio: boolean;
}

export interface GenerationDraft {
  version: 1;
  revision: number;
  prompt: string;
  referenceIds: string[];
  parameters: GenerationParameters;
}

export function emptyGenerationDraft(): GenerationDraft {
  return {
    version: 1,
    revision: 0,
    prompt: '',
    referenceIds: [],
    parameters: {
      model: 'seedance-2.0',
      ratio: 'adaptive',
      resolution: '720p',
      duration: 5,
      generateAudio: true,
    },
  };
}

export function validateGenerationDraft(value: unknown): GenerationDraft {
  if (!value || typeof value !== 'object') throw new Error('生成草稿无效');
  const draft = value as GenerationDraft;
  const p = draft.parameters;
  if (
    draft.version !== 1 ||
    !Number.isSafeInteger(draft.revision) ||
    draft.revision < 0 ||
    typeof draft.prompt !== 'string' ||
    draft.prompt.length > MAX_PROMPT_LENGTH ||
    !Array.isArray(draft.referenceIds) ||
    draft.referenceIds.length > MAX_REFERENCES ||
    draft.referenceIds.some(
      (id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id),
    ) ||
    new Set(draft.referenceIds).size !== draft.referenceIds.length ||
    !p ||
    !GENERATION_MODELS.includes(p.model) ||
    !GENERATION_RATIOS.includes(p.ratio) ||
    !GENERATION_RESOLUTIONS.includes(p.resolution) ||
    (p.model === 'seedance-2.0-fast' && p.resolution === '1080p') ||
    !Number.isInteger(p.duration) ||
    (p.duration !== -1 && (p.duration < 4 || p.duration > 15)) ||
    typeof p.generateAudio !== 'boolean'
  )
    throw new Error('生成草稿的文本、素材或参数无效');
  return {
    version: 1,
    revision: draft.revision,
    prompt: draft.prompt,
    referenceIds: [...draft.referenceIds],
    parameters: {
      model: p.model,
      ratio: p.ratio,
      resolution: p.resolution,
      duration: p.duration,
      generateAudio: p.generateAudio,
    },
  };
}

export interface ReferenceImportResult {
  /** Complete, protected intake IDs; the project save queue may still be pending. */
  assetIds: string[];
  /** Per-file intake failures; their IDs must never be added to a workspace. */
  errors: string[];
  cancelled: boolean;
  /** Current incomplete file and files not started; completed files remain accepted. */
  cancelledCount: number;
}
