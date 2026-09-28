import { useCallback, useEffect, useRef, useState } from 'react';
import type { LibraryState, ProjectSnapshot } from '../../../../shared/models';

export function useLibrary() {
  const [library, setLibrary] = useState<LibraryState | null>(null);
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operations, setOperations] = useState(0);
  const activeId = useRef<string | null>(null);
  const revision = useRef(0);

  const report = useCallback((reason: unknown) => {
    setError(
      reason instanceof Error
        ? reason.message.replace(
            /^Error invoking remote method '[^']+': (Error: )?/,
            '',
          )
        : String(reason),
    );
  }, []);

  const refresh = useCallback(async () => {
    const current = ++revision.current;
    const state = await window.desktop.getLibrary();
    const id = activeId.current;
    const snapshot = id ? await window.desktop.openProject(id) : null;
    if (current === revision.current && id === activeId.current) {
      setLibrary(state);
      setProject(snapshot);
    }
  }, []);

  const run = useCallback(
    async (operation: () => Promise<unknown>) => {
      setError(null);
      setOperations((count) => count + 1);
      try {
        await operation();
        await refresh();
      } catch (reason) {
        report(reason);
      } finally {
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
      clearTimeout(timer);
      timer = setTimeout(() => {
        void refresh().catch(report);
      }, 50);
    });
    return () => {
      stop();
      clearTimeout(timer);
      revision.current += 1;
    };
  }, [refresh, report]);

  const open = (id: string) =>
    run(async () => {
      const snapshot = await window.desktop.openProject(id);
      activeId.current = id;
      setProject(snapshot);
    });
  const create = (name: string) =>
    run(async () => {
      const snapshot = await window.desktop.createProject(name);
      activeId.current = snapshot.project.id;
      setProject(snapshot);
    });
  const home = () => {
    activeId.current = null;
    revision.current += 1;
    setProject(null);
  };
  return {
    library,
    project,
    error,
    busy: operations > 0,
    run,
    open,
    create,
    home,
    report,
    clearError: () => setError(null),
  };
}
