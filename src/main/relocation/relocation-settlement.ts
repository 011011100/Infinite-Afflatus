import { lstatSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readAnchor, sameAnchor } from '../backups/backup-anchor';
import {
  ANCHOR_FILE,
  identity,
  readJson,
  sameIdentity,
} from '../backups/backup-files';
import {
  directoryIdentitySync,
  ordinaryFileState,
  ordinaryFileStateSync,
  sameFileState,
} from '../saving/file-state';
import { syncDirectory } from '../storage/files';
import { databaseProof, same } from './relocation-files';
import {
  RELOCATION_FILE,
  type RelocationIntent,
} from './root-relocation-types';

/** Full content proof, then only synchronous identity checks at the deletion decision. */
async function settlementProof(userData: string, intent: RelocationIntent) {
  const anchorPath = join(userData, ANCHOR_FILE);
  const anchorState = await ordinaryFileState(anchorPath);
  if (
    !sameAnchor(await readAnchor(userData), intent.resultAnchor) ||
    !sameFileState(anchorState, await ordinaryFileState(anchorPath))
  )
    throw new Error('新目录代际在收尾期间变化，重定位记录已保留');
  const originalPath = join(intent.retained.path, 'app.sqlite');
  const original = await databaseProof(originalPath);
  const source = join(userData, 'app.sqlite');
  const published = await databaseProof(source);
  if (
    !original ||
    !published ||
    !same(original.evidence, intent.original) ||
    !same(published.evidence, intent.candidate)
  )
    throw new Error('重定位发布位置或原库留档已变化，候选与恢复记录已保留');
  return () => {
    for (const directory of [
      intent.resultAnchor.userData,
      intent.resultAnchor.root,
      intent.retained,
    ])
      if (
        !sameIdentity(
          identity(directoryIdentitySync(directory.path)),
          directory,
        )
      )
        throw new Error('重定位目录在收尾期间变化');
    try {
      lstatSync(intent.anchor.root.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (
        !sameFileState(anchorState, ordinaryFileStateSync(anchorPath)) ||
        !sameFileState(original.state, ordinaryFileStateSync(originalPath)) ||
        !sameFileState(published.state, ordinaryFileStateSync(source))
      )
        throw new Error('重定位资料在收尾期间变化，恢复记录已保留');
      return;
    }
    throw new Error('原保存位置在重定位期间重新出现');
  };
}

export async function settleRelocation(
  userData: string,
  intent: RelocationIntent,
) {
  const candidatePath = join(intent.retained.path, 'new-app.sqlite');
  const candidate = await databaseProof(candidatePath);
  if (candidate) {
    if (!same(candidate.evidence, intent.candidate))
      throw new Error('重定位候选文件身份已变化');
    const assertCurrent = await settlementProof(userData, intent);
    assertCurrent();
    if (!sameFileState(candidate.state, ordinaryFileStateSync(candidatePath)))
      throw new Error('重定位候选文件在清理前变化');
    await unlink(candidatePath);
    await syncDirectory(intent.retained.path);
  }
  const intentPath = join(userData, RELOCATION_FILE);
  const intentState = await ordinaryFileState(intentPath);
  if (!same(await readJson(intentPath), intent))
    throw new Error('重定位恢复记录在收尾期间变化');
  const assertCurrent = await settlementProof(userData, intent);
  assertCurrent();
  if (!sameFileState(intentState, ordinaryFileStateSync(intentPath)))
    throw new Error('重定位恢复记录在清理前变化');
  await unlink(intentPath);
  await syncDirectory(userData);
}
