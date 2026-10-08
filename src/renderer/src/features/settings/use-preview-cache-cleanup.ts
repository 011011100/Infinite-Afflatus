import { useEffect, useRef, useState } from 'react';
import type {
  PreviewCacheCleanupPreview,
  PreviewCacheCleanupResult,
} from '../../../../shared/preview-cache';
import { message } from '../generation/errors';

type Operation = 'checking' | 'cleaning';
type Attempt = { operation: Operation; request: number; cancelling: boolean };

/** Only a current, visible preview can authorize one explicit cleanup. */
export function usePreviewCacheCleanup(active: boolean, disabled: boolean) {
  const [preview, setPreview] = useState<PreviewCacheCleanupPreview | null>(
    null,
  );
  const [result, setResult] = useState<PreviewCacheCleanupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [stopping, setStopping] = useState(false);
  const [valid, setValid] = useState(false);
  const mounted = useRef(false);
  const current = useRef({ active, disabled });
  current.current = { active, disabled };
  const epoch = useRef(0);
  const pending = useRef<Attempt | null>(null);
  const authorization = useRef<string | null>(null);

  const cancelNative = (request: number, attempt: Attempt | null = null) => {
    // Send now, never from a late reply/finally that could cancel a newer scan.
    void window.desktop.cancelPreviewCacheOperations().catch((reason) => {
      if (!mounted.current) return;
      if (attempt?.operation === 'cleaning') {
        if (pending.current !== attempt) return;
        attempt.cancelling = false;
        setStopping(false);
      } else if (epoch.current !== request) return;
      setError(`停止请求未完成：${message(reason)}`);
    });
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
      if (
        authorization.current ||
        (pending.current && !pending.current.cancelling)
      )
        void window.desktop
          .cancelPreviewCacheOperations()
          .catch(() => undefined);
      authorization.current = null;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Only visibility and write admission invalidate this panel's current authorization.
  useEffect(() => {
    if (active && !disabled) return;
    const request = ++epoch.current;
    const attempt = pending.current;
    const shouldCancel =
      !!authorization.current || (!!attempt && !attempt.cancelling);
    authorization.current = null;
    setPreview(null);
    setValid(false);
    if (attempt?.operation === 'checking') {
      pending.current = null;
      setBusy(null);
    } else if (attempt) {
      attempt.cancelling = true;
      setStopping(true);
    }
    if (shouldCancel) cancelNative(request, attempt);
  }, [active, disabled]);

  useEffect(() => {
    if (!valid || !preview?.expiresAt) return;
    const expire = () => {
      if (authorization.current !== preview.token) return;
      authorization.current = null;
      setValid(false);
    };
    const delay = Date.parse(preview.expiresAt) - Date.now();
    if (delay <= 0) {
      expire();
      return;
    }
    const timer = setTimeout(expire, delay);
    return () => clearTimeout(timer);
  }, [preview, valid]);

  const inspect = async () => {
    if (!current.current.active || current.current.disabled || pending.current)
      return false;
    const attempt: Attempt = {
      operation: 'checking',
      request: ++epoch.current,
      cancelling: false,
    };
    pending.current = attempt;
    authorization.current = null;
    setValid(false);
    setError(null);
    setBusy('checking');
    const isCurrent = () =>
      mounted.current &&
      current.current.active &&
      !current.current.disabled &&
      epoch.current === attempt.request;
    try {
      const next = await window.desktop.previewCacheCleanup();
      if (!isCurrent()) return false;
      const available =
        !!next.files.length &&
        !!next.token &&
        !!next.expiresAt &&
        Date.parse(next.expiresAt) > Date.now();
      authorization.current = available ? next.token : null;
      setPreview(next);
      setValid(available);
      return true;
    } catch (reason) {
      if (isCurrent()) setError(message(reason));
      return false;
    } finally {
      if (pending.current === attempt) {
        pending.current = null;
        if (mounted.current) setBusy(null);
      }
    }
  };

  const execute = async () => {
    if (
      !current.current.active ||
      current.current.disabled ||
      pending.current ||
      !valid ||
      !preview?.files.length ||
      !preview.token ||
      !preview.expiresAt ||
      authorization.current !== preview.token
    )
      return;
    if (Date.parse(preview.expiresAt) <= Date.now()) {
      authorization.current = null;
      setValid(false);
      return;
    }
    const attempt: Attempt = {
      operation: 'cleaning',
      request: ++epoch.current,
      cancelling: false,
    };
    pending.current = attempt;
    authorization.current = null;
    setValid(false);
    setError(null);
    setBusy('cleaning');
    setStopping(false);
    try {
      const next = await window.desktop.executePreviewCacheCleanup(
        preview.token,
      );
      // Explicitly confirmed work reports its real outcome even after a tab switch.
      if (!mounted.current || pending.current !== attempt) return;
      setResult(next);
      setPreview(null);
      setError(null);
    } catch (reason) {
      if (mounted.current && pending.current === attempt)
        setError(message(reason));
    } finally {
      if (pending.current === attempt) {
        pending.current = null;
        if (mounted.current) {
          setBusy(null);
          setStopping(false);
        }
      }
    }
  };

  const dismiss = () => {
    if (pending.current?.operation === 'cleaning') return;
    const request = ++epoch.current;
    const shouldCancel = !!authorization.current || !!pending.current;
    authorization.current = null;
    pending.current = null;
    setPreview(null);
    setValid(false);
    setBusy(null);
    setError(null);
    if (shouldCancel) cancelNative(request);
  };

  const stop = async () => {
    const attempt = pending.current;
    if (attempt?.operation !== 'cleaning' || attempt.cancelling) return;
    attempt.cancelling = true;
    setStopping(true);
    setError(null);
    try {
      await window.desktop.cancelPreviewCacheOperations();
    } catch (reason) {
      if (!mounted.current || pending.current !== attempt) return;
      attempt.cancelling = false;
      setStopping(false);
      setError(`停止请求未完成：${message(reason)}`);
    }
  };

  return {
    preview,
    result,
    error,
    busy,
    stopping,
    valid,
    inspect,
    execute,
    dismiss,
    stop,
  };
}
