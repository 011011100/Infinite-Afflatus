import { lstat } from 'node:fs/promises';
import type { Asset } from '../../shared/models';
import type {
  ProjectAssetIssue,
  ProjectHealthMode,
} from '../../shared/project-health';
import { validatePackagePath } from '../packages/package-format';
import { safeFile } from '../storage/files';
import { verifyFile } from './verified-file';

/** Recovery is limited to managed asset paths, never a database or arbitrary project file. */
export function validateAsset(asset: Asset) {
  validatePackagePath(asset.relativePath);
  if (
    !asset.relativePath.startsWith('assets/') ||
    !Number.isSafeInteger(asset.size) ||
    asset.size < 0 ||
    !/^[a-f0-9]{64}$/.test(asset.sha256)
  )
    throw new Error('素材记录或路径无效');
}

export async function inspectAsset(
  root: string,
  asset: Asset,
  mode: ProjectHealthMode,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<ProjectAssetIssue | null> {
  const issue = (
    problem: ProjectAssetIssue['problem'],
    message: string,
  ): ProjectAssetIssue => ({
    assetId: asset.id,
    name: asset.name,
    kind: asset.kind,
    relativePath: asset.relativePath,
    problem,
    message,
  });
  try {
    validateAsset(asset);
  } catch {
    return issue('unsafe', '素材记录或路径无效，未读取或修改文件');
  }
  try {
    signal.throwIfAborted();
    const file = await safeFile(root, asset.relativePath);
    if ((await lstat(file)).size !== asset.size)
      return issue('changed', '文件大小与原素材不一致，现有文件不会被覆盖');
    if (mode === 'full') {
      const checked = await verifyFile(file, asset.size, signal, progress);
      if (checked.size !== asset.size || checked.sha256 !== asset.sha256)
        return issue('changed', '文件内容与原素材不一致，现有文件不会被覆盖');
    }
    return null;
  } catch (error) {
    signal.throwIfAborted();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT')
      return issue(
        'missing',
        '原位置找不到素材，可选择内容完全相同的原文件恢复',
      );
    if (
      code === 'ELOOP' ||
      (error instanceof Error && /符号链接|路径|普通文件/.test(error.message))
    )
      return issue('unsafe', '路径包含链接或不是普通文件，未读取或修改文件');
    return issue(
      'unreadable',
      '无法读取素材，请检查磁盘、文件权限或是否正被其他程序修改',
    );
  }
}
