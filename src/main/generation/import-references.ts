import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Readable } from 'node:stream';
import {
  MAX_REFERENCES,
  type ReferenceImportResult,
} from '../../shared/generation/draft';
import { referenceKind } from '../../shared/generation/reference-files';
import type { SaveJob } from '../../shared/models';
import type { GeneratedResult } from '../saving/staging';
import { errorMessage } from '../storage/database';
import { localFileStream } from '../storage/files';

interface ReferenceReceiver {
  acceptResult(result: GeneratedResult, stream: Readable): Promise<SaveJob>;
}

/** Only completed intake may become a workspace reference; a failed file does not reject its siblings. */
export async function importReferenceFiles(
  receiver: ReferenceReceiver,
  projectId: string,
  files: string[],
): Promise<ReferenceImportResult> {
  if (files.length > MAX_REFERENCES)
    throw new Error(`一次最多导入 ${MAX_REFERENCES} 个素材`);
  const imported: ReferenceImportResult = { assetIds: [], errors: [] };
  for (const file of files) {
    let stream: Readable | undefined;
    try {
      const extension = extname(file).slice(1).toLowerCase();
      const kind = referenceKind(extension);
      if (!kind) throw new Error('不支持的素材格式');
      if (kind === 'text' && (await stat(file)).size > 1024 * 1024)
        throw new Error('文本素材不能超过 1 MB');
      stream = await localFileStream(file);
      const job = await receiver.acceptResult(
        {
          projectId,
          resultKey: `reference:${randomUUID()}`,
          name: basename(file),
          kind,
          usage: 'reference',
          extension,
        },
        stream,
      );
      // Intake returns failed jobs instead of rejecting (empty files, disk errors,
      // or publication failures). A digest alone does not prove publication.
      if (
        job.status === 'receiving' ||
        job.status === 'failed' ||
        !job.sha256 ||
        job.size <= 0
      )
        throw new Error(job.error ?? '素材接收未完成，请重新导入原文件');
      // A complete ready result remains a valid stable reference while migration
      // or a later project-save failure keeps its protected bytes in staging.
      imported.assetIds.push(job.id);
    } catch (error) {
      stream?.destroy();
      imported.errors.push(`${basename(file)}：${errorMessage(error)}`);
    }
  }
  return imported;
}
