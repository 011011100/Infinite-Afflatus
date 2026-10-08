import { useCallback, useEffect, useRef, useState } from 'react';
import { flushPendingChanges } from '@/features/lifecycle/pending-saves';
import type {
  ArkGenerationJob,
  ArkGenerationPreview,
  ArkGenerationTarget,
} from '../../../../../shared/generation/ark-types';
import { message } from '../errors';

type View = 'review' | 'history' | null;
export function useArkGeneration({
  target,
  sourceVersion,
  disabled,
  pendingAdoptionJobId = null,
  onAdopt,
}: {
  target: ArkGenerationTarget;
  sourceVersion: string;
  disabled: boolean;
  pendingAdoptionJobId?: string | null;
  onAdopt?: ((jobId: string) => Promise<void>) | undefined;
}) {
  const [view, setView] = useState<View>(null);
  const [preview, setPreview] = useState<ArkGenerationPreview | null>(null);
  const [jobs, setJobs] = useState<ArkGenerationJob[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const alive = useRef(false);
  const request = useRef(0);
  const reads = useRef(0);
  const pending = useRef<string | null>(null);
  const reviewed = useRef<{
    preview: ArkGenerationPreview;
    source: string;
  } | null>(null);
  const latest = useRef({
    target,
    sourceVersion,
    disabled,
    pendingAdoptionJobId,
    onAdopt,
  });
  latest.current = {
    target,
    sourceVersion,
    disabled,
    pendingAdoptionJobId,
    onAdopt,
  };
  const cancelPreview = useCallback(() => {
    const old = reviewed.current;
    reviewed.current = null;
    if (old)
      void window.desktop.cancelArkPreview(old.preview.token).catch(() => {});
    setPreview(null);
  }, []);
  const reload = useCallback(async () => {
    const ticket = ++reads.current;
    const { projectId, shotId, groupId } = latest.current.target;
    try {
      const incoming = await window.desktop.listArkJobs(
        projectId,
        shotId,
        groupId,
      );
      if (!alive.current || ticket !== reads.current) return;
      setJobs(incoming);
      setHistoryError(null);
    } catch (reason) {
      if (alive.current && ticket === reads.current)
        setHistoryError(message(reason));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    const timer = setTimeout(() => void reload(), 0);
    const unsubscribe = window.desktop.onArkJobsChanged(() => void reload());
    return () => {
      alive.current = false;
      request.current++;
      reads.current++;
      clearTimeout(timer);
      unsubscribe();
      const old = reviewed.current;
      reviewed.current = null;
      if (old)
        void window.desktop.cancelArkPreview(old.preview.token).catch(() => {});
    };
  }, [reload]);
  useEffect(() => {
    if (
      !reviewed.current ||
      (reviewed.current.source === sourceVersion && !disabled)
    )
      return;
    cancelPreview();
    setError('生成组或编辑状态已改变，原确认已失效。请重新检查后提交。');
  }, [sourceVersion, disabled, cancelPreview]);
  const close = () => {
    request.current++;
    cancelPreview();
    if (pending.current === 'preview') {
      pending.current = null;
      setBusy(null);
    }
    setView(null);
  };
  const begin = async () => {
    if (pending.current || latest.current.disabled) return;
    cancelPreview();
    pending.current = 'preview';
    const ticket = ++request.current;
    setView('review');
    setBusy('preview');
    setError(null);
    try {
      if (!(await flushPendingChanges()))
        throw new Error('当前编辑尚未保存。请先处理保存提示，再确认生成。');
      if (
        !alive.current ||
        ticket !== request.current ||
        latest.current.disabled
      )
        return;
      const source = latest.current.sourceVersion;
      const next = await window.desktop.previewArkGeneration(
        latest.current.target,
      );
      if (
        !alive.current ||
        ticket !== request.current ||
        latest.current.disabled ||
        source !== latest.current.sourceVersion
      ) {
        void window.desktop.cancelArkPreview(next.token).catch(() => {});
        if (alive.current && ticket === request.current)
          setError('生成组已改变，请重新检查生成内容。');
        return;
      }
      reviewed.current = {
        preview: next,
        source: latest.current.sourceVersion,
      };
      setPreview(next);
    } catch (reason) {
      if (alive.current && ticket === request.current)
        setError(message(reason));
    } finally {
      if (alive.current && ticket === request.current) {
        pending.current = null;
        setBusy(null);
      }
    }
  };
  const submit = async () => {
    const approved = reviewed.current;
    if (pending.current || !approved || latest.current.disabled) return;
    if (
      approved.source !== latest.current.sourceVersion ||
      Date.parse(approved.preview.expiresAt) <= Date.now()
    ) {
      cancelPreview();
      setError('本次确认已失效。请重新检查生成内容。');
      return;
    }
    pending.current = 'submit';
    // Consume the token before awaiting IPC: same-tick repeated clicks cannot send again.
    reviewed.current = null;
    setPreview(null);
    setBusy('submit');
    setError(null);
    setView('history');
    try {
      const job = await window.desktop.submitArkGeneration(
        approved.preview.token,
      );
      if (alive.current)
        setJobs((previous) => [
          job,
          ...previous.filter((item) => item.id !== job.id),
        ]);
    } catch (reason) {
      if (alive.current) {
        setUncertain(true);
        setError(`${message(reason)}。请先查看任务记录；未自动重新提交。`);
      }
    } finally {
      if (alive.current) {
        pending.current = null;
        setBusy(null);
        void reload();
      }
    }
  };
  const act = async (id: string, action: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = id;
    setBusy(id);
    setError(null);
    try {
      await action();
    } catch (reason) {
      if (alive.current) setError(message(reason));
    } finally {
      if (alive.current) {
        pending.current = null;
        setBusy(null);
        void reload();
      }
    }
  };
  const adopt = (id: string) =>
    act(`adopt:${id}`, async () => {
      if (
        (latest.current.disabled &&
          latest.current.pendingAdoptionJobId !== id) ||
        !latest.current.onAdopt
      )
        throw new Error('当前镜头暂不可采纳，请返回可编辑的项目后重试。');
      // The project-scoped adoption callback owns flush, locking, revision checks,
      // and installation of the authoritative result. Never overwrite via refetch.
      await latest.current.onAdopt(id);
    });
  return {
    view,
    preview,
    jobs,
    busy,
    error,
    historyError,
    uncertain,
    begin,
    submit,
    close,
    history: () => {
      cancelPreview();
      setError(null);
      setView('history');
      void reload();
    },
    reload,
    act,
    adopt,
  };
}
