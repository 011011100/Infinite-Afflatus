import { useEffect, useRef, useState } from 'react';
import type {
  RescueImportPreview,
  RescueImportResult,
} from '../../../../shared/rescue-import';
import { projectErrorMessage } from '../projects/library-session';
import { notifyDraftLists } from './draft-list-events';

type Operation = 'checking' | 'importing' | 'cancelling';
interface CompletedImport {
  result: RescueImportResult;
  preview: RescueImportPreview;
}

/** Preview authorization ends on dismissal. A confirmed native publication can outlive this panel. */
export function useDraftImport(active: boolean, disabled: boolean) {
  const [preview, setPreview] = useState<RescueImportPreview | null>(null);
  const [completed, setCompleted] = useState<CompletedImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [valid, setValid] = useState(false);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const current = useRef({ active, disabled });
  current.current = { active, disabled };
  const pending = useRef<{ operation: Operation; request: number } | null>(
    null,
  );
  const authorization = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    setPreview(null);
    setValid(false);
    return () => {
      mounted.current = false;
      epoch.current++;
      const shouldCancel =
        pending.current?.operation === 'checking' || !!authorization.current;
      authorization.current = null;
      // Invoke cancellation now, never from a late finally that could cancel
      // a newer picker. Confirmed imports finish and notify outside this epoch.
      if (active && shouldCancel)
        void window.desktop.cancelRescueImport().catch(() => undefined);
    };
  }, [active]);

  useEffect(() => {
    if (!valid || !preview) return;
    const expire = () => {
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

  const perform = async (
    operation: Operation,
    action: (isCurrent: () => boolean) => Promise<void>,
  ) => {
    if (!current.current.active || pending.current) return;
    const attempt = { operation, request: ++epoch.current };
    pending.current = attempt;
    setBusy(operation);
    setError(null);
    const isCurrent = () =>
      mounted.current &&
      current.current.active &&
      epoch.current === attempt.request;
    try {
      await action(isCurrent);
    } catch (reason) {
      if (isCurrent()) setError(projectErrorMessage(reason));
    } finally {
      if (pending.current === attempt) {
        pending.current = null;
        if (mounted.current) setBusy(null);
      }
    }
  };

  const choose = () => {
    if (current.current.disabled) return Promise.resolve();
    return perform('checking', async (isCurrent) => {
      authorization.current = null;
      setPreview(null);
      setValid(false);
      const next = await window.desktop.chooseRescueImport();
      if (!isCurrent() || !next) return;
      const available = Date.parse(next.expiresAt) > Date.now();
      authorization.current = available ? next.token : null;
      setPreview(next);
      setValid(available);
    });
  };
  const confirm = () => {
    if (
      current.current.disabled ||
      !preview ||
      !valid ||
      authorization.current !== preview.token
    )
      return Promise.resolve();
    if (Date.parse(preview.expiresAt) <= Date.now()) {
      authorization.current = null;
      setValid(false);
      return Promise.resolve();
    }
    return perform('importing', async (isCurrent) => {
      authorization.current = null;
      setValid(false);
      const result = await window.desktop.confirmRescueImport(preview.token);
      // A completed import is durable even when settings closed or changed tab.
      notifyDraftLists(result.projectId);
      if (!isCurrent()) return;
      setCompleted({ result, preview });
      setPreview(null);
    });
  };
  const dismiss = () =>
    perform('cancelling', async () => {
      authorization.current = null;
      setPreview(null);
      setValid(false);
      await window.desktop.cancelRescueImport();
    });

  return { preview, completed, error, busy, valid, choose, confirm, dismiss };
}
