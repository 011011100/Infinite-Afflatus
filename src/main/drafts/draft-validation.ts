import { validateWorkspace } from '../../shared/generation/workspace';
import type {
  WorkspaceDraftInput,
  WorkspaceDraftKey,
  WorkspaceDraftRecord,
} from '../../shared/workspace-draft';

export const MAX_DRAFT_BYTES = 16 * 1024 * 1024;
export const MAX_DRAFT_STORAGE_BYTES = 256 * 1024 * 1024;
export const MAX_DRAFT_FILES = 2048;

export function draftId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw new Error('无效的草稿标识');
  return value;
}

export function draftKey(input: unknown): WorkspaceDraftKey {
  const value = input as WorkspaceDraftKey;
  const sessionId = draftId(value?.sessionId);
  if (!Number.isSafeInteger(value.seq) || value.seq < 1)
    throw new Error('无效的草稿顺序');
  return { sessionId, seq: value.seq };
}

export function draftInput(input: unknown): WorkspaceDraftInput {
  const key = draftKey(input);
  const value = input as WorkspaceDraftInput;
  // Bound serialization before walking a large workspace. Cycles are rejected too.
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_DRAFT_BYTES)
    throw new Error('镜头恢复草稿超过 16 MB，尚未建立恢复副本');
  const baseline = validateWorkspace(value.baseline);
  const workspace = validateWorkspace(value.workspace);
  if (baseline.revision !== workspace.revision)
    throw new Error('恢复草稿与确认基线版本不一致');
  const lastSubmitted =
    value.lastSubmitted === undefined
      ? undefined
      : validateWorkspace(value.lastSubmitted);
  if (lastSubmitted && lastSubmitted.revision !== baseline.revision + 1)
    throw new Error('恢复草稿的在途提交版本无效');
  return {
    ...key,
    baseline,
    workspace,
    ...(lastSubmitted ? { lastSubmitted } : {}),
  };
}

export function draftRecord(input: unknown): WorkspaceDraftRecord {
  const value = input as WorkspaceDraftRecord;
  if (
    value?.format !== 'infinite-afflatus-workspace-draft' ||
    value.version !== 1 ||
    typeof value.saved !== 'boolean' ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    typeof value.project?.name !== 'string' ||
    !value.project.name.trim() ||
    value.project.name.length > 100
  )
    throw new Error('恢复草稿格式无效，原文件已保留');
  return {
    ...draftInput(value),
    format: value.format,
    version: value.version,
    updatedAt: value.updatedAt,
    saved: value.saved,
    project: {
      id: draftId(value.project.id),
      folder: draftId(value.project.folder),
      name: value.project.name,
    },
  };
}
