import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { WorkspaceDraftRecord } from '../../shared/workspace-draft';
import { overlaps, syncDirectory } from '../storage/files';

/** A readable rescue file, deliberately not an importable project package. */
export async function exportDraft(
  record: WorkspaceDraftRecord,
  destination: string,
  storage: string,
) {
  if (
    !isAbsolute(destination) ||
    !destination.endsWith('.afflatus-draft.json') ||
    overlaps(storage, destination)
  )
    throw new Error('请选择恢复目录以外的 .afflatus-draft.json 文件');
  const parent = dirname(destination);
  if ((await realpath(parent)) !== resolve(parent))
    throw new Error('导出目录不能包含符号链接');
  const handle = await open(
    destination,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  const identity = await handle.stat();
  let complete = false;
  try {
    await handle.writeFile(
      JSON.stringify(
        {
          format: 'infinite-afflatus-workspace-rescue',
          version: 1,
          notice:
            '只读镜头救援文件：含文本、参数、分组、素材引用及确认基线。不含原始媒体、未提交名称输入、主画布裁剪或撤销历史，不能作为完整项目包导入。',
          draft: record,
        },
        null,
        2,
      ),
    );
    await handle.sync();
    await syncDirectory(parent);
    complete = true;
    return destination;
  } finally {
    await handle.close();
    if (!complete) {
      const current = await lstat(destination).catch(() => null);
      if (
        current &&
        !current.isSymbolicLink() &&
        current.dev === identity.dev &&
        current.ino === identity.ino
      )
        await unlink(destination);
    }
  }
}
