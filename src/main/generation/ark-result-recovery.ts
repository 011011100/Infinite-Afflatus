import { createHash } from 'node:crypto';
import type { ArkAdoptionResult } from '../../shared/generation/ark-types';
import type { Asset } from '../../shared/models';
import { withProject } from '../projects/project-database';
import type { ProjectService } from '../projects/project-service';
import type { ProjectReferenceReader } from '../saving/project-reference-reader';
import type { ArkStoredJob } from './ark-journal';

/** Prove committed bytes without recreating an archived save queue after index restore. */
export async function verifyArkCommittedResult(
  projects: ProjectService,
  references: ProjectReferenceReader,
  job: ArkStoredJob,
): Promise<{ adoptedShotId?: string }> {
  const assetId = job.saveJobId;
  if (!assetId || !job.resultKey || !job.resultSha256 || !job.resultSize)
    throw new Error('结果缺少可核对的完整保存记录');
  const database = await projects.databasePath(job.projectId);
  const expected = projects.summary(job.projectId);
  const read = () =>
    withProject(
      database,
      false,
      (db) => {
        const row = db
          .prepare('SELECT result_key, payload FROM assets WHERE id = ?')
          .get(assetId);
        const asset = row
          ? (JSON.parse(String(row.payload)) as Asset)
          : undefined;
        if (
          !asset ||
          row?.result_key !== job.resultKey ||
          asset.kind !== job.kind ||
          asset.sha256 !== job.resultSha256 ||
          asset.size !== job.resultSize
        )
          throw new Error('项目中没有与原任务匹配的候选结果');
        const value = db
          .prepare("SELECT value FROM metadata WHERE key = 'ark-adoptions'")
          .get();
        const receipts = value
          ? (JSON.parse(String(value.value)) as ArkAdoptionResult[])
          : [];
        const receipt = receipts.find(
          (item) =>
            item.jobId === job.id &&
            item.assetId === assetId &&
            item.kind === job.kind,
        );
        if (asset.usage !== 'reference' && !receipt)
          throw new Error('候选结果用途与记录不匹配');
        return { asset, receipt };
      },
      expected,
    );
  const before = read();
  const media = await references.acquire(job.projectId, assetId, job.kind);
  if (media?.source !== 'committed') {
    await media?.handle.close();
    throw new Error('项目中没有可验证的已保存候选文件');
  }
  try {
    const start = await media.handle.stat();
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of media.handle.createReadStream({
      autoClose: false,
    })) {
      hash.update(chunk);
      size += chunk.length;
    }
    const end = await media.handle.stat();
    if (
      size !== job.resultSize ||
      hash.digest('hex') !== job.resultSha256 ||
      start.size !== end.size ||
      start.mtimeMs !== end.mtimeMs ||
      start.ctimeMs !== end.ctimeMs ||
      JSON.stringify(read()) !== JSON.stringify(before)
    )
      throw new Error('已保存候选文件在检查期间发生变化');
    return before.receipt ? { adoptedShotId: before.receipt.shotId } : {};
  } finally {
    await media.handle.close();
  }
}
