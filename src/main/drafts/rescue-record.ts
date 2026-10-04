import type { ProjectEditDraftRecord } from '../../shared/project-edit-draft';
import type { WorkspaceDraftRecord } from '../../shared/workspace-draft';
import { syncDirectory } from '../storage/files';
import type { DraftFiles } from './draft-files';
import { draftRecord } from './draft-validation';
import { projectEditRecord } from './project-edit-validation';

export type RescueRecord = WorkspaceDraftRecord | ProjectEditDraftRecord;
export const isWorkspaceRescue = (
  record: RescueRecord,
): record is WorkspaceDraftRecord =>
  record.format === 'infinite-afflatus-workspace-draft';

export function decodeRescue(input: unknown): RescueRecord {
  if (!input || typeof input !== 'object') throw new Error('救援文件格式无效');
  const value = input as {
    format?: unknown;
    version?: unknown;
    draft?: unknown;
  };
  if (value.version !== 1)
    throw new Error('救援文件版本不受支持，原文件已保留');
  if (value.format === 'infinite-afflatus-workspace-rescue')
    return draftRecord(value.draft);
  if (value.format === 'infinite-afflatus-project-edit-rescue')
    return projectEditRecord(value.draft);
  throw new Error('这不是支持的镜头、名称或裁剪救援文件');
}

export function stableRescueValue(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

/** Import namespaces are independent of active renderer streams and their acknowledgements. */
export function isImportedRescue(record: RescueRecord) {
  return /^rescue-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    record.sessionId,
  );
}

export function rescueContent(record: RescueRecord): string {
  return stableRescueValue({
    format: record.format,
    project: { id: record.project.id, folder: record.project.folder },
    baseline: record.baseline,
    ...(isWorkspaceRescue(record)
      ? { workspace: record.workspace }
      : {
          kind: record.kind,
          target: record.target,
          ...(record.kind === 'trim' ? { assets: record.assets } : {}),
        }),
    ...(record.lastSubmitted === undefined
      ? {}
      : { lastSubmitted: record.lastSubmitted }),
  });
}

/** Runs inside the owning draft service's existing serialized file queue. */
export async function addRescueRecord<T extends RescueRecord>(
  files: DraftFiles<T>,
  record: T,
  beforeAdd: () => Promise<void>,
) {
  if (
    !isImportedRescue(record) ||
    record.seq !== 1 ||
    (isWorkspaceRescue(record) && record.saved)
  )
    throw new Error('导入副本必须使用独立恢复标识');
  const prefix = `${record.project.id}.rescue-`;
  const signature = rescueContent(record);
  for (const name of await files.entries()) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    let existing: T | null;
    try {
      existing = await files.read(name);
    } catch {
      continue;
    }
    if (
      existing &&
      isImportedRescue(existing) &&
      name === `${existing.project.id}.${existing.sessionId}.json` &&
      !(isWorkspaceRescue(existing) && existing.saved) &&
      rescueContent(existing) === signature
    ) {
      await beforeAdd();
      // A prior attempt may have published successfully but lost the directory
      // fsync acknowledgement. Confirm durability without replacing its bytes.
      await syncDirectory(files.directory);
      return { record: existing, duplicate: true };
    }
  }
  await beforeAdd();
  const name = `${record.project.id}.${record.sessionId}.json`;
  if (await files.read(name))
    throw new Error('独立恢复标识已经存在，原副本已保留');
  try {
    await files.write(name, record, null);
  } catch (error) {
    const published = await files.read(name).catch(() => null);
    if (published && rescueContent(published) === signature)
      throw new Error(
        '恢复副本可能已写入，但落盘确认失败；请重试导入检查，原文件已保留',
        { cause: error },
      );
    throw error;
  }
  return { record, duplicate: false };
}
