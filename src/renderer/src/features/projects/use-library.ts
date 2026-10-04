import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { LibrarySession, projectErrorMessage } from './library-session';
import { projectRecoveryGuards } from './project-recovery-guards';

export function useLibrary() {
  const [session] = useState(
    () =>
      new LibrarySession(
        {
          getLibrary: () => window.desktop.getLibrary(),
          openProject: (id) => window.desktop.openProject(id),
        },
        (id, snapshot) => projectRecoveryGuards.verify(id, snapshot),
      ),
  );
  const { library, project, projectUnavailable } = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
  );
  const [error, setError] = useState<string | null>(null);
  const [operations, setOperations] = useState(0);
  const activeOperations = useRef(0);
  const [importingPackage, setImportingPackage] = useState(false);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const report = useCallback(
    (reason: unknown) => {
      setError(projectErrorMessage(reason));
      if (checkTimer.current) clearTimeout(checkTimer.current);
      // A rejected write emits no library change. Diagnose once without creating a report/refresh loop.
      checkTimer.current = setTimeout(() => {
        void session.refreshProject();
      }, 50);
    },
    [session],
  );

  const refresh = useCallback(async () => {
    await session.refresh();
  }, [session]);

  const run = useCallback(
    async (operation: () => Promise<unknown>) => {
      setError(null);
      activeOperations.current++;
      setOperations((count) => count + 1);
      try {
        await operation();
        await refresh();
      } catch (reason) {
        report(reason);
      } finally {
        activeOperations.current--;
        setOperations((count) => count - 1);
      }
    },
    [refresh, report],
  );

  useEffect(() => {
    if (!window.desktop) {
      setError('请通过桌面应用打开，浏览器无法访问本地项目。');
      return;
    }
    void refresh().catch(report);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = window.desktop.onLibraryChanged(() => {
      session.noteLibraryChange();
      clearTimeout(timer);
      timer = setTimeout(() => {
        void refresh().catch(report);
      }, 50);
    });
    const focus = () => {
      // Native import dialogs also return focus while their expected library mutation is in flight.
      void session.refresh(activeOperations.current === 0).catch(report);
    };
    const visible = () => {
      if (!document.hidden) focus();
    };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visible);
    return () => {
      stop();
      clearTimeout(timer);
      if (checkTimer.current) clearTimeout(checkTimer.current);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visible);
      session.dispose();
    };
  }, [refresh, report, session]);

  const open = (id: string) => run(() => session.open(id));
  const create = (name: string) =>
    run(async () => {
      const snapshot = await window.desktop.createProject(name);
      session.activate(snapshot);
    });
  const importPackage = () => {
    setImportingPackage(true);
    return run(async () => {
      const snapshot = await window.desktop.importProjectPackage();
      if (!snapshot) return;
      session.activate(snapshot);
    }).finally(() => setImportingPackage(false));
  };
  const home = () => {
    session.home();
  };
  return {
    library,
    project,
    projectUnavailable,
    retryProject: () => session.refreshProject(true),
    reportProjectFailure: (reason: unknown) => session.failProject(reason),
    error,
    busy: operations > 0,
    run,
    open,
    create,
    importPackage,
    importingPackage,
    cancelPackage: () => run(() => window.desktop.cancelProjectPackage()),
    home,
    report,
    clearError: () => setError(null),
  };
}
