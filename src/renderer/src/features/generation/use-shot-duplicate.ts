import { type RefObject, useLayoutEffect, useRef, useState } from 'react';
import {
  capturePendingSaves,
  flushPendingChanges,
} from '@/features/lifecycle/pending-saves';
import { usePendingSave } from '@/features/lifecycle/use-pending-save';
import {
  captureFocus,
  type FocusSnapshot,
  restoreFocusAfterCommit,
} from '@/lib/focus-restoration';
import { acquireInert } from '@/lib/inert-lease';
import { message } from './errors';

/** Finish local editors before the parent saves and opens an independent shot. */
export function useShotDuplicate({
  page,
  disabled,
  onDuplicate,
  report,
}: {
  page: RefObject<HTMLElement | null>;
  disabled: boolean;
  onDuplicate: (() => Promise<boolean>) | undefined;
  report: (error: string | null) => void;
}) {
  const latest = useRef({ disabled, onDuplicate, report });
  latest.current = { disabled, onDuplicate, report };
  const alive = useRef(false);
  const epoch = useRef(0);
  const pending = useRef<{
    promise: Promise<boolean>;
    release: () => void;
  } | null>(null);
  const [copying, setCopying] = useState(false);
  const [restore, setRestore] = useState<{
    epoch: number;
    focus: FocusSnapshot | null;
  } | null>(null);

  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current += 1;
      pending.current?.release();
      pending.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    if (copying || !restore) return;
    return restoreFocusAfterCommit(restore.focus, {
      isCurrent: () =>
        alive.current && !pending.current && epoch.current === restore.epoch,
      fallback: page.current,
    });
  }, [copying, restore, page]);

  // A native leave observes this whole operation. Its own pre-copy flush must
  // not await itself; the parent's shot save remains the actual flush owner.
  usePendingSave(
    '复制镜头前的输入',
    () => Promise.resolve(true),
    0,
    () => pending.current?.promise ?? null,
  );

  const duplicate = (): Promise<boolean> => {
    if (pending.current) return pending.current.promise;
    const element = page.current;
    if (
      !alive.current ||
      !element?.isConnected ||
      element.closest('[inert]') ||
      latest.current.disabled ||
      !latest.current.onDuplicate
    )
      return Promise.resolve(false);

    // Capture existing work before publishing this operation to leave guards.
    const captured = capturePendingSaves();
    const currentEpoch = ++epoch.current;
    const focus = captureFocus();
    const release = acquireInert(element);
    const isCurrent = () => alive.current && epoch.current === currentEpoch;
    setCopying(true);
    latest.current.report(null);
    const promise: Promise<boolean> = Promise.resolve().then(async () => {
      let completed = false;
      try {
        const settled = await captured;
        if (!isCurrent()) return false;
        const flushed = await flushPendingChanges();
        if (!isCurrent()) return false;
        if (!settled || !flushed || latest.current.disabled) {
          latest.current.report(
            '当前镜头尚未保存完成，请检查保存提示后重试复制。',
          );
          return false;
        }
        completed = (await latest.current.onDuplicate?.()) ?? false;
        if (isCurrent() && !completed)
          latest.current.report(
            '镜头复制尚未完成，请重试。已创建的副本会保留，不会重复创建。',
          );
        return completed;
      } catch (reason) {
        if (isCurrent()) latest.current.report(message(reason));
        return false;
      } finally {
        release();
        if (pending.current?.promise === promise) pending.current = null;
        if (isCurrent()) {
          setCopying(false);
          if (!completed) setRestore({ epoch: currentEpoch, focus });
        }
      }
    });
    pending.current = { promise, release };
    if (focus && element.contains(focus.target)) focus.target.blur();
    return promise;
  };

  return { copying, duplicate, isCopying: () => pending.current !== null };
}
