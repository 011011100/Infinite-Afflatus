import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import {
  MAX_REFERENCES,
  type ReferenceImportResult,
} from '../../shared/generation/draft';
import { referenceKind } from '../../shared/generation/reference-files';
import type { ReferenceImportProgress } from '../../shared/generation/reference-import';
import type { SaveJob } from '../../shared/models';
import {
  type GeneratedResult,
  STAGING_CANCELLED,
  type StagingReceiveControls,
} from '../saving/staging';
import { errorMessage } from '../storage/database';
import { localFileStream } from '../storage/files';

export interface ReferenceReceiver {
  acceptResult(
    result: GeneratedResult,
    stream: Readable,
    controls?: StagingReceiveControls,
  ): Promise<SaveJob>;
}

export type ReferenceFileProgress = Omit<
  ReferenceImportProgress,
  'requestId' | 'projectId'
>;

interface ReferenceImportControls {
  signal?: AbortSignal;
  onProgress?: (progress: ReferenceFileProgress) => void;
}

/** Only completed intake may become a workspace reference; a failed file does not reject its siblings. */
export async function importReferenceFiles(
  receiver: ReferenceReceiver,
  projectId: string,
  files: string[],
  controls: ReferenceImportControls = {},
): Promise<ReferenceImportResult> {
  if (files.length > MAX_REFERENCES)
    throw new Error(`一次最多导入 ${MAX_REFERENCES} 个素材`);
  const imported: ReferenceImportResult = {
    assetIds: [],
    errors: [],
    cancelled: false,
    cancelledCount: 0,
  };
  for (const [index, file] of files.entries()) {
    if (controls.signal?.aborted) {
      imported.cancelledCount += files.length - index;
      break;
    }
    const progress: ReferenceFileProgress = {
      phase: 'receiving',
      fileIndex: index + 1,
      totalFiles: files.length,
      fileName: basename(file),
      receivedBytes: 0,
      fileBytes: null,
      acceptedCount: imported.assetIds.length,
      failedCount: imported.errors.length,
    };
    const notify = () =>
      controls.onProgress?.({
        ...progress,
        acceptedCount: imported.assetIds.length,
        failedCount: imported.errors.length,
      });
    notify();
    let stream: Readable | undefined;
    const abort = () => stream?.destroy(controls.signal?.reason);
    try {
      controls.signal?.throwIfAborted();
      const extension = extname(file).slice(1).toLowerCase();
      const kind = referenceKind(extension);
      if (!kind) throw new Error('不支持的素材格式');
      progress.fileBytes = (await stat(file)).size;
      controls.signal?.throwIfAborted();
      if (kind === 'text' && progress.fileBytes > 1024 * 1024)
        throw new Error('文本素材不能超过 1 MB');
      stream = await localFileStream(file);
      stream.on('error', () => undefined);
      controls.signal?.throwIfAborted();
      controls.signal?.addEventListener('abort', abort, { once: true });
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
        {
          ...(controls.signal ? { signal: controls.signal } : {}),
          onProgress: ({ phase, bytes }) => {
            progress.phase = phase;
            progress.receivedBytes = bytes;
            notify();
          },
        },
      );
      // Intake returns failed jobs instead of rejecting (empty files, disk errors,
      // or publication failures). A digest alone does not prove publication.
      if (
        job.status === 'receiving' ||
        job.status === 'failed' ||
        !job.sha256 ||
        job.size <= 0
      ) {
        if (controls.signal?.aborted && job.error === STAGING_CANCELLED) {
          imported.cancelledCount += 1;
          continue;
        }
        throw new Error(job.error ?? '素材接收未完成，请重新导入原文件');
      }
      // A complete ready result remains a valid stable reference while migration
      // or a later project-save failure keeps its protected bytes in staging.
      imported.assetIds.push(job.id);
    } catch (error) {
      if (
        controls.signal?.aborted &&
        (error === controls.signal.reason ||
          (error instanceof Error && error.name === 'AbortError'))
      )
        imported.cancelledCount += 1;
      else imported.errors.push(`${basename(file)}：${errorMessage(error)}`);
    } finally {
      controls.signal?.removeEventListener('abort', abort);
      // A cancellation result must not leave a source handle writing in the background.
      if (stream) {
        stream.destroy();
        await finished(stream, { cleanup: true }).catch(() => undefined);
      }
      notify();
    }
  }
  imported.cancelled = controls.signal?.aborted ?? false;
  return imported;
}
