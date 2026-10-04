import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppBackupInfo,
  AppBackupList,
} from '../../../../shared/app-backup';
import { projectErrorMessage } from '../projects/library-session';

type Operation = 'listing' | 'creating' | 'revealing' | 'retained';

/** This screen creates new checkpoints only; replacement is a startup-only operation. */
export function useAppBackups(active: boolean) {
  const [list, setList] = useState<AppBackupList | null>(null);
  const [created, setCreated] = useState<AppBackupInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);
  const pending = useRef(false);
  const loaded = useRef(false);
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current++;
      pending.current = false;
    },
    [],
  );

  const perform = useCallback(
    async (
      operation: Operation,
      action: (isCurrent: () => boolean) => Promise<void>,
    ) => {
      if (pending.current) return;
      pending.current = true;
      const request = ++epoch.current;
      const isCurrent = () => request === epoch.current;
      setBusy(operation);
      try {
        await action(isCurrent);
      } catch (reason) {
        if (isCurrent()) setError(projectErrorMessage(reason));
      } finally {
        if (isCurrent()) {
          pending.current = false;
          setBusy(null);
        }
      }
    },
    [],
  );

  const refresh = useCallback(
    () =>
      perform('listing', async (isCurrent) => {
        const next = await window.desktop.getAppBackups();
        if (!isCurrent()) return;
        loaded.current = true;
        setList(next);
        setError(null);
      }),
    [perform],
  );
  useEffect(() => {
    if (!active || loaded.current) return;
    // StrictMode cleanup cancels the probe; merely opening another settings tab
    // must not start directory scans or create a backup.
    const timer = setTimeout(() => {
      void refresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [active, refresh]);

  const create = () =>
    perform('creating', async (isCurrent) => {
      const next = await window.desktop.createAppBackup();
      if (!isCurrent()) return;
      setCreated(next);
      setError(null);
      setList((previous) =>
        previous
          ? {
              ...previous,
              backups: [
                next,
                ...previous.backups.filter((item) => item.id !== next.id),
              ],
            }
          : previous,
      );
      try {
        const found = await window.desktop.getAppBackups();
        if (!isCurrent()) return;
        loaded.current = true;
        setList(found);
      } catch (reason) {
        if (isCurrent())
          setError(
            `备份已创建，但列表刷新失败：${projectErrorMessage(reason)}`,
          );
      }
    });
  const reveal = (retained = false) =>
    perform(retained ? 'retained' : 'revealing', async (isCurrent) => {
      if (retained) await window.desktop.revealRetainedAppData();
      else await window.desktop.revealAppBackups();
      if (isCurrent()) setError(null);
    });
  return { list, created, error, busy, refresh, create, reveal };
}
