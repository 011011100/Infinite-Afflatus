import { randomUUID } from 'node:crypto';
import type { ReferenceImportResult } from '../../shared/generation/draft';
import type { ReferenceImportProgress } from '../../shared/generation/reference-import';
import {
  importReferenceFiles,
  type ReferenceReceiver,
} from './import-references';

interface ReferenceSavePause {
  idle(): Promise<void>;
  resume(): void;
}

interface ReferenceSaves {
  pauseLocalReferences(): ReferenceSavePause;
}

interface ActiveImport {
  requestId: string;
  controller: AbortController;
  done: Promise<void>;
  progress: ReferenceImportProgress;
  report: (progress: ReferenceImportProgress, force?: boolean) => void;
}

interface Selection {
  canceled: boolean;
  filePaths: string[];
}

const cancelledSelection = (): ReferenceImportResult => ({
  assetIds: [],
  errors: [],
  cancelled: true,
  cancelledCount: 0,
});

/** Owns local imports and leave pauses independently of Electron windows and UI state. */
export class ReferenceImportService {
  private readonly active = new Map<number, ActiveImport>();
  private readonly pauses = new Map<
    string,
    { ownerId: number; handle: ReferenceSavePause }
  >();
  private closing: Promise<void> | null = null;

  constructor(
    private readonly receiver: ReferenceReceiver,
    private readonly saves: ReferenceSaves,
  ) {}

  async run(
    ownerId: number,
    projectId: string,
    requestId: string,
    choose: () => Promise<Selection>,
    onProgress?: (progress: ReferenceImportProgress) => void,
  ): Promise<ReferenceImportResult> {
    if (this.closing) throw new Error('应用正在关闭，无法导入素材');
    if ([...this.pauses.values()].some((pause) => pause.ownerId === ownerId))
      return cancelledSelection();
    if (this.active.has(ownerId)) throw new Error('该窗口已有素材正在导入');
    let finish!: () => void;
    let lastReport = -Infinity;
    let previous: ReferenceImportProgress | null = null;
    const work: ActiveImport = {
      requestId,
      controller: new AbortController(),
      done: new Promise((resolve) => {
        finish = resolve;
      }),
      progress: {
        requestId,
        projectId,
        phase: 'choosing',
        fileIndex: 0,
        totalFiles: 0,
        fileName: null,
        receivedBytes: 0,
        fileBytes: null,
        acceptedCount: 0,
        failedCount: 0,
      },
      report: (progress, force = false) => {
        work.progress = progress;
        const now = performance.now();
        if (
          !force &&
          previous &&
          previous.phase === progress.phase &&
          previous.fileIndex === progress.fileIndex &&
          previous.acceptedCount === progress.acceptedCount &&
          previous.failedCount === progress.failedCount &&
          now - lastReport < 200
        )
          return;
        lastReport = now;
        previous = progress;
        try {
          onProgress?.({ ...progress });
        } catch {
          // A destroyed UI observer cannot turn a durable intake into a failed file.
        }
      },
    };
    // Register cancellation before opening a native chooser, including synchronous callbacks.
    this.active.set(ownerId, work);
    work.report(work.progress, true);
    try {
      const selected = await this.choose(work.controller.signal, choose);
      const result =
        selected && !selected.canceled
          ? await importReferenceFiles(
              this.receiver,
              projectId,
              selected.filePaths,
              {
                signal: work.controller.signal,
                onProgress: (progress) =>
                  work.report({
                    ...progress,
                    requestId,
                    projectId,
                    ...(work.controller.signal.aborted
                      ? { phase: 'cancelling' as const }
                      : {}),
                  }),
              },
            )
          : cancelledSelection();
      work.report(
        {
          ...work.progress,
          phase: result.cancelled ? 'cancelled' : 'completed',
          acceptedCount: result.assetIds.length,
          failedCount: result.errors.length,
        },
        true,
      );
      return result;
    } catch (error) {
      work.report(
        {
          ...work.progress,
          phase: work.controller.signal.aborted ? 'cancelled' : 'completed',
        },
        true,
      );
      throw error;
    } finally {
      if (this.active.get(ownerId) === work) this.active.delete(ownerId);
      finish();
    }
  }

  cancel(ownerId: number, requestId: string): Promise<void> {
    const work = this.active.get(ownerId);
    if (!work || work.requestId !== requestId) return Promise.resolve();
    this.abort(work);
    return work.done;
  }

  async prepareForLeave(ownerId: number): Promise<string> {
    if (this.closing) throw new Error('应用正在关闭');
    const token = randomUUID();
    const handle = this.saves.pauseLocalReferences();
    this.pauses.set(token, { ownerId, handle });
    const work = this.active.get(ownerId);
    if (work) this.abort(work);
    try {
      await Promise.all([work?.done, handle.idle()]);
      return token;
    } catch (error) {
      if (!this.closing) this.resumeAfterLeave(ownerId, token);
      throw error;
    }
  }

  resumeAfterLeave(ownerId: number, token: string): void {
    const pause = this.pauses.get(token);
    if (!pause) return;
    if (pause.ownerId !== ownerId)
      throw new Error('无法恢复其他窗口的素材保存');
    if (this.closing) return;
    this.pauses.delete(token);
    pause.handle.resume();
  }

  resumeOwner(ownerId: number): void {
    for (const [token, pause] of this.pauses)
      if (pause.ownerId === ownerId) this.resumeAfterLeave(ownerId, token);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const handle = this.saves.pauseLocalReferences();
    const work = [...this.active.values()];
    // Mark closed before any observer triggered by abort can start another run.
    this.closing = Promise.resolve().then(async () => {
      await Promise.all([...work.map((item) => item.done), handle.idle()]);
    });
    for (const item of work) this.abort(item);
    return this.closing;
  }

  private abort(work: ActiveImport): void {
    if (
      work.controller.signal.aborted ||
      work.progress.phase === 'completed' ||
      work.progress.phase === 'cancelled'
    )
      return;
    work.controller.abort(new DOMException('素材导入已取消', 'AbortError'));
    work.report({ ...work.progress, phase: 'cancelling' }, true);
  }

  private async choose(
    signal: AbortSignal,
    choose: () => Promise<Selection>,
  ): Promise<Selection | null> {
    if (signal.aborted) return null;
    let cancel!: () => void;
    const cancelled = new Promise<null>((resolve) => {
      cancel = () => resolve(null);
    });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      // Promise.race observes even a late rejected chooser; its late files are never ingested.
      return await Promise.race([choose(), cancelled]);
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
}
