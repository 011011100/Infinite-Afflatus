import { useEffect, useRef, useState } from 'react';
import type { ReferenceImportResult } from '../../../../shared/generation/draft';
import type { ReferenceImportProgress } from '../../../../shared/generation/reference-import';
import { usePendingSave } from '../lifecycle/use-pending-save';
import { message } from './errors';

type ImportAttempt = {
  id: string;
  promise: Promise<boolean>;
  cancellation: Promise<boolean> | null;
  cancelling: boolean;
  target: { accept(ids: string[]): boolean; finish(): void };
  result: ReferenceImportResult | null;
};

/** A batch belongs to the shot that opened it; progress never changes that owner. */
export function useReferenceImport(
  projectId: string,
  createTarget: () => ImportAttempt['target'] | null,
) {
  const active = useRef<ImportAttempt | null>(null);
  const alive = useRef(false);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<ReferenceImportProgress | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [pendingAssets, setPendingAssets] = useState(false);
  usePendingSave(
    `导入镜头素材:${projectId}`,
    () => active.current?.promise ?? Promise.resolve(true),
    -10,
    () => active.current?.promise ?? null,
  );
  useEffect(() => {
    alive.current = true;
    const unsubscribe = window.desktop.onReferenceImportProgress((next) => {
      const attempt = active.current;
      if (next.projectId !== projectId || next.requestId !== attempt?.id)
        return;
      if (next.phase === 'cancelling') attempt.cancelling = true;
      setProgress(attempt.cancelling ? { ...next, phase: 'cancelling' } : next);
    });
    return () => {
      alive.current = false;
      unsubscribe();
      const attempt = active.current;
      if (attempt)
        void window.desktop.cancelReferenceImport(attempt.id).catch(() => {});
      attempt?.target.finish();
    };
  }, [projectId]);

  const accept = (attempt: ImportAttempt): boolean => {
    const result = attempt.result;
    if (!result || !alive.current || active.current !== attempt) return false;
    if (result.assetIds.length && !attempt.target.accept(result.assetIds)) {
      setPendingAssets(true);
      setLocalError(
        '素材已完整接收，但尚未加入原镜头。已保留待添加引用，请结束恢复后重试添加；未完成前会保留当前页面。',
      );
      return false;
    }
    setPendingAssets(false);
    setLocalError(
      result.errors.length
        ? [
            `已添加 ${result.assetIds.length} 个素材；${result.errors.length} 个未添加。`,
            ...result.errors,
          ].join('\n')
        : null,
    );
    setNotice(
      result.cancelled
        ? `已取消导入。已添加 ${result.assetIds.length} 个素材，${result.cancelledCount} 个未完成。`
        : result.errors.length
          ? null
          : `已添加 ${result.assetIds.length} 个素材。`,
    );
    attempt.target.finish();
    active.current = null;
    return true;
  };

  const importFiles = (): Promise<boolean> => {
    if (active.current) return active.current.promise;
    const target = createTarget();
    if (!target) {
      setLocalError('当前镜头暂不能导入素材，请结束恢复或恢复项目后重试。');
      return Promise.resolve(false);
    }
    const id = crypto.randomUUID();
    const attempt: ImportAttempt = {
      id,
      cancellation: null,
      cancelling: false,
      promise: Promise.resolve(true),
      target,
      result: null,
    };
    active.current = attempt;
    setImporting(true);
    setLocalError(null);
    setNotice(null);
    setProgress({
      requestId: id,
      projectId,
      phase: 'choosing',
      fileIndex: 0,
      totalFiles: 0,
      fileName: null,
      receivedBytes: 0,
      fileBytes: null,
      acceptedCount: 0,
      failedCount: 0,
    });
    // The target was reserved in the original shot before opening native UI.
    attempt.promise = Promise.resolve()
      .then(() =>
        attempt.cancelling
          ? { assetIds: [], errors: [], cancelled: true, cancelledCount: 0 }
          : window.desktop.importReferences(projectId, id),
      )
      .then((result) => {
        if (!alive.current || active.current !== attempt) return false;
        attempt.result = result;
        // A cancelled selection/batch is not a failed draft save. Complete IDs
        // have reached the shot before its lower-priority save begins.
        return accept(attempt);
      })
      .catch((reason) => {
        if (alive.current && active.current === attempt) {
          setLocalError(message(reason));
          setPendingAssets(!!attempt.result?.assetIds.length);
        }
        return false;
      })
      .finally(() => {
        if (active.current && active.current !== attempt) return;
        if (!attempt.result) {
          attempt.target.finish();
          if (active.current === attempt) active.current = null;
        }
        if (alive.current) {
          setImporting(false);
          setProgress(null);
        }
      });
    return attempt.promise;
  };

  const cancelImport = (): Promise<boolean> => {
    const attempt = active.current;
    if (!attempt) return Promise.resolve(true);
    if (attempt.result) return Promise.resolve(false);
    if (attempt.cancellation) return attempt.cancellation;
    attempt.cancelling = true;
    setProgress((value) => (value ? { ...value, phase: 'cancelling' } : value));
    attempt.cancellation = window.desktop
      .cancelReferenceImport(attempt.id)
      .then(() => attempt.promise)
      .catch((reason) => {
        if (alive.current && active.current === attempt) {
          setLocalError(message(reason));
          attempt.cancelling = false;
          attempt.cancellation = null;
          setProgress((value) =>
            value
              ? {
                  ...value,
                  phase: value.fileIndex ? 'receiving' : 'choosing',
                }
              : value,
          );
        }
        return false;
      });
    return attempt.cancellation;
  };
  return {
    importFiles,
    cancelImport,
    importing,
    progress,
    notice,
    dismissNotice: () => setNotice(null),
    localError,
    setLocalError,
    pendingAssets,
    retryAdding: () => {
      const attempt = active.current;
      if (!attempt?.result) return Promise.resolve(true);
      attempt.promise = Promise.resolve()
        .then(() => accept(attempt))
        .catch((reason) => {
          setLocalError(message(reason));
          return false;
        });
      return attempt.promise;
    },
  };
}
