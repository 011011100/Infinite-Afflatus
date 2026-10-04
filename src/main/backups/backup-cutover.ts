import type { MigrationJournal } from '../migration/manifest';
import {
  readProject,
  verifyProjectDatabase,
} from '../projects/project-database';
import { fingerprint, safeFile, sameContent } from '../storage/files';

/** A cutover intent can only converge toward the fully verified destination, never delete it. */
export async function verifyCutover(journal: MigrationJournal, exact = false) {
  for (const entry of journal.files) {
    if (!entry.copied) throw new Error('迁移切换记录缺少完整副本，未自动恢复');
    const path = await safeFile(journal.status.target, entry.relativePath);
    if (exact && !sameContent(await fingerprint(path), entry.source))
      throw new Error('切换目标数据库或素材已变化，未覆盖原项目路由');
    if (entry.relativePath.endsWith('/project.sqlite')) {
      const folder = entry.relativePath.split('/')[0];
      if (!folder) throw new Error('迁移项目路径无效');
      verifyProjectDatabase(path, { id: entry.projectId, folder });
      const project = readProject(path, { id: entry.projectId, folder });
      for (const asset of journal.files.filter(
        (item) =>
          item.projectId === entry.projectId &&
          !item.relativePath.endsWith('/project.sqlite'),
      ))
        if (
          !project.assets.some(
            (item) =>
              `${folder}/${item.relativePath}` === asset.relativePath &&
              item.sha256 === asset.source.sha256,
          )
        )
          throw new Error('切换目标项目缺少原素材记录，原资料已保留');
    } else if (!sameContent(await fingerprint(path), entry.source)) {
      throw new Error('切换目标素材校验失败，原资料已保留');
    }
  }
}
