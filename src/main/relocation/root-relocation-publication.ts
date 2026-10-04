import { link, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeAnchor, readAnchor, sameAnchor } from '../backups/backup-anchor';
import {
  ANCHOR_FILE,
  directoryIdentity,
  info,
  readJson,
  sameIdentity,
  UUID,
  validIdentity,
  verifyDirectory,
  writeJson,
} from '../backups/backup-files';
import { syncDirectory } from '../storage/files';
import {
  projectsIn,
  readApplication,
  requireProjection,
  requireStableApplication,
} from './relocation-database';
import { databaseEvidence, same } from './relocation-files';
import { settleRelocation } from './relocation-settlement';
import {
  inspectProjects,
  requireMissingRoot,
  requireNoRestore,
} from './root-relocation-inspection';
import {
  type DatabaseEvidence,
  RELOCATION_DIRECTORY,
  RELOCATION_FILE,
  type RelocationIntent,
} from './root-relocation-types';

function validEvidence(value: unknown): value is DatabaseEvidence {
  const item = value as DatabaseEvidence;
  return (
    validIdentity(item) &&
    typeof item.size === 'string' &&
    /^\d+$/.test(item.size) &&
    BigInt(item.size) <= 512n * 1024n * 1024n &&
    typeof item.mtimeNs === 'string' &&
    /^-?\d+$/.test(item.mtimeNs) &&
    typeof item.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(item.sha256)
  );
}
export function relocationIntent(
  value: unknown,
  userData: string,
): RelocationIntent {
  const item = value as RelocationIntent;
  if (
    item?.format !== 'infinite-afflatus-root-relocation' ||
    item.version !== 1 ||
    !UUID.test(item.id) ||
    !validIdentity(item.retained) ||
    item.retained.path !== join(userData, RELOCATION_DIRECTORY, item.id) ||
    !validEvidence(item.original) ||
    !validEvidence(item.candidate) ||
    !Array.isArray(item.projects)
  )
    throw new Error('目录重定位记录损坏或版本不受支持，原文件已保留');
  decodeAnchor(item.anchor);
  decodeAnchor(item.resultAnchor);
  if (
    item.anchor.userData.path !== userData ||
    item.anchor.generation === item.resultAnchor.generation ||
    item.anchor.root.path === item.resultAnchor.root.path ||
    !sameIdentity(item.anchor.root, item.resultAnchor.root) ||
    !sameAnchor(
      {
        ...item.anchor,
        generation: item.resultAnchor.generation,
        root: item.resultAnchor.root,
      },
      item.resultAnchor,
    )
  )
    throw new Error('目录重定位代际或目录身份无效，原文件已保留');
  const ids = new Set<string>();
  for (const entry of item.projects) {
    if (
      !entry?.project ||
      !UUID.test(entry.project.id) ||
      entry.project.id !== entry.project.folder ||
      ids.has(entry.project.id) ||
      !validIdentity(entry.directory) ||
      entry.directory.path !==
        join(item.resultAnchor.root.path, entry.project.folder) ||
      !validEvidence(entry.database)
    )
      throw new Error('目录重定位项目证据无效，原文件已保留');
    ids.add(entry.project.id);
  }
  return item;
}

/** No worker may start until this converges or fails closed. It never edits projects or queue rows. */
export async function finishRelocation(
  userData: string,
  input: RelocationIntent,
) {
  const intent = relocationIntent(input, userData);
  await requireNoRestore(userData);
  const anchor = await readAnchor(userData);
  const atOld = sameAnchor(anchor, intent.anchor);
  const atNew = sameAnchor(anchor, intent.resultAnchor);
  if (!atOld && !atNew) throw new Error('目录重定位代际已变化，未自动续接');
  await requireMissingRoot(intent.anchor.root.path);
  await verifyDirectory(intent.resultAnchor.root);
  await directoryIdentity(join(userData, RELOCATION_DIRECTORY));
  await verifyDirectory(intent.retained);
  if (
    !same(
      await inspectProjects(
        intent.resultAnchor.root.path,
        intent.projects.map((entry) => entry.project),
      ),
      intent.projects,
    )
  )
    throw new Error('项目数据库在重定位期间变化，原资料已保留');
  const source = join(userData, 'app.sqlite');
  const archive = join(intent.retained.path, 'app.sqlite');
  const candidate = join(intent.retained.path, 'new-app.sqlite');
  const live = await databaseEvidence(source);
  const saved = await databaseEvidence(archive);
  const prepared = await databaseEvidence(candidate);
  const published = same(live, intent.candidate);
  if (atNew && !published)
    throw new Error('新目录代际与应用数据库不符，未覆盖');
  if (
    (!published && !same(prepared, intent.candidate)) ||
    (prepared && !same(prepared, intent.candidate))
  )
    throw new Error('重定位候选数据库已变化，原资料已保留');
  if (
    saved
      ? !same(saved, intent.original) || (live && !published)
      : !same(live, intent.original) || published
  )
    throw new Error('重定位原数据库归档或当前位置已变化，未覆盖');
  const original = await readApplication(saved ? archive : source);
  const replacement = await readApplication(published ? source : candidate);
  requireStableApplication(original.data, intent.anchor);
  requireStableApplication(replacement.data, intent.resultAnchor);
  requireProjection(original.data, replacement.data, intent.resultAnchor);
  if (
    !same(
      projectsIn(original.data),
      intent.projects.map((entry) => entry.project),
    )
  )
    throw new Error('重定位项目索引不符');
  // These sidecars must remain absent even when app.sqlite itself is between locations.
  for (const suffix of ['-wal', '-shm', '-journal'])
    if (await info(`${source}${suffix}`))
      throw new Error('重定位期间出现数据库日志，原文件已保留');
  if (!saved) {
    if (!same(await databaseEvidence(source), intent.original))
      throw new Error('原数据库在归档前变化');
    await verifyDirectory(intent.retained);
    if (await info(archive))
      throw new Error('原库留档位置出现其他文件，未覆盖');
    await rename(source, archive);
    await syncDirectory(intent.retained.path);
    await syncDirectory(userData);
  }
  if (!published) {
    if (await info(source))
      throw new Error('应用数据库位置出现其他文件，未覆盖');
    if (!same(await databaseEvidence(candidate), intent.candidate))
      throw new Error('候选数据库在发布前变化');
    await link(candidate, source);
    await syncDirectory(userData);
  }
  if (!same(await databaseEvidence(source), intent.candidate))
    throw new Error('重定位数据库发布校验失败');
  await requireMissingRoot(intent.anchor.root.path);
  await verifyDirectory(intent.resultAnchor.root);
  if (atOld)
    await writeJson(
      join(userData, ANCHOR_FILE),
      intent.resultAnchor,
      intent.anchor,
    );
  await settleRelocation(userData, intent);
}

export async function resumeRelocation(userData: string) {
  if (!(await info(userData))) return;
  await directoryIdentity(userData);
  const path = join(userData, RELOCATION_FILE);
  if (!(await info(path))) return;
  await finishRelocation(
    userData,
    relocationIntent(await readJson(path), userData),
  );
}
