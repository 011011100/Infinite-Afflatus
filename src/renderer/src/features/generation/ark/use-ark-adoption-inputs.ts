import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import {
  capturePendingSaves,
  flushPendingChanges,
} from '@/features/lifecycle/pending-saves';
import { usePendingSave } from '@/features/lifecycle/use-pending-save';

/** Protect the entire input flush + authoritative adoption across native leave. */
export function useArkAdoptionInputs({
  page,
  shotId,
  disabled,
  pendingAdoptionJobId = null,
  importing,
  onAdopt,
}: {
  page: RefObject<HTMLElement | null>;
  shotId: string;
  disabled: boolean;
  pendingAdoptionJobId?: string | null;
  importing: boolean;
  onAdopt?: ((jobId: string) => Promise<void>) | undefined;
}) {
  const latest = useRef({ disabled, pendingAdoptionJobId, importing, onAdopt });
  latest.current = { disabled, pendingAdoptionJobId, importing, onAdopt };
  const alive = useRef(false);
  const epoch = useRef(0);
  const operation = useRef<{ jobId: string; promise: Promise<void> } | null>(
    null,
  );
  const [pending, setPending] = useState(false);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
    };
  }, []);
  useLayoutEffect(() => {
    void shotId;
    epoch.current++;
  }, [shotId]);
  usePendingSave(
    '采纳候选前的输入',
    () => Promise.resolve(true),
    0,
    () =>
      operation.current?.promise.then(
        () => true,
        () => false,
      ) ?? null,
  );
  const adopt = (jobId: string): Promise<void> => {
    if (operation.current) {
      if (operation.current.jobId === jobId) return operation.current.promise;
      return Promise.reject(new Error('请先完成当前候选结果的采纳。'));
    }
    const allowed = () =>
      alive.current &&
      page.current?.isConnected &&
      !latest.current.importing &&
      (!latest.current.disabled ||
        latest.current.pendingAdoptionJobId === jobId) &&
      !!latest.current.onAdopt;
    if (!allowed())
      return Promise.reject(
        new Error('当前镜头不可采纳，请先完成素材导入与编辑保存。'),
      );
    // Capture earlier work before registering this operation, avoiding self-await.
    const captured = capturePendingSaves();
    const ticket = epoch.current;
    const promise = Promise.resolve().then(async () => {
      try {
        if (latest.current.pendingAdoptionJobId !== jobId) {
          if (!(await captured) || !(await flushPendingChanges()))
            throw new Error('当前编辑尚未保存，请处理保存提示后重试采纳。');
        }
        if (ticket !== epoch.current || !allowed())
          throw new Error(
            '镜头或编辑状态已改变，未采纳候选。请重新打开任务后检查。',
          );
        setPending(true);
        await latest.current.onAdopt?.(jobId);
      } finally {
        if (operation.current?.promise === promise) operation.current = null;
        if (alive.current && ticket === epoch.current) setPending(false);
      }
    });
    operation.current = { jobId, promise };
    return promise;
  };
  return { pending, adopt, isPending: () => operation.current !== null };
}
