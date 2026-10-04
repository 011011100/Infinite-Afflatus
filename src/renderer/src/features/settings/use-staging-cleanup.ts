import { useEffect, useRef, useState } from 'react';
import type {
  StagingCleanupPreview,
  StagingCleanupResult,
} from '../../../../shared/staging-cleanup';
import { message } from '../generation/errors';

/** A confirmation always belongs to one completed preview, never a later scan. */
export function useStagingCleanup() {
  const [preview, setPreview] = useState<StagingCleanupPreview | null>(null);
  const [result, setResult] = useState<StagingCleanupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'checking' | 'cleaning' | null>(null);
  const [valid, setValid] = useState(false);
  const pending = useRef(false);
  const authorized = useRef<string | null>(null);
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current++;
      authorized.current = null;
      pending.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!valid || !preview?.expiresAt) return;
    const expire = () => {
      authorized.current = null;
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
    if (pending.current) return;
    pending.current = true;
    const request = ++epoch.current;
    authorized.current = null;
    setBusy('checking');
    setValid(false);
    try {
      const next = await window.desktop.previewStagingCleanup();
      if (epoch.current !== request) return;
      setPreview(next);
      const valid =
        !!next.token &&
        !!next.expiresAt &&
        Date.parse(next.expiresAt) > Date.now();
      authorized.current = valid ? next.token : null;
      setValid(valid);
      setError(null);
    } catch (reason) {
      if (epoch.current === request) setError(message(reason));
    } finally {
      if (epoch.current === request) {
        pending.current = false;
        setBusy(null);
      }
    }
  };
  const execute = async () => {
    if (
      pending.current ||
      !valid ||
      !preview?.token ||
      !preview.expiresAt ||
      authorized.current !== preview.token
    )
      return;
    if (Date.parse(preview.expiresAt) <= Date.now()) {
      authorized.current = null;
      setValid(false);
      return;
    }
    pending.current = true;
    const request = ++epoch.current;
    const token = preview.token;
    authorized.current = null;
    setBusy('cleaning');
    setValid(false);
    try {
      const next = await window.desktop.executeStagingCleanup(token);
      if (epoch.current !== request) return;
      setResult(next);
      setError(null);
    } catch (reason) {
      if (epoch.current === request) setError(message(reason));
    } finally {
      if (epoch.current === request) {
        pending.current = false;
        setBusy(null);
      }
    }
  };
  return {
    preview,
    result,
    error,
    busy,
    valid,
    inspect,
    execute,
    dismiss: () => {
      if (pending.current) return;
      epoch.current++;
      authorized.current = null;
      setPreview(null);
      setValid(false);
    },
  };
}
