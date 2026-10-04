import { useEffect, useRef, useState } from 'react';
import type { Viewport } from '../../../../shared/models';
import { LatestSaveQueue } from '../lifecycle/latest-save-queue';
import { usePendingSave } from '../lifecycle/use-pending-save';

export function useViewportSave(
  projectId: string,
  blocked: boolean,
  report: (reason: unknown) => void,
) {
  const reportError = useRef(report);
  reportError.current = report;
  const locked = useRef(blocked);
  locked.current = blocked;
  const [queue] = useState(
    () =>
      new LatestSaveQueue<Viewport>(
        async (viewport) => {
          try {
            await window.desktop.saveViewport(projectId, viewport);
          } catch (error) {
            reportError.current(error);
            throw error;
          }
        },
        () => !locked.current,
      ),
  );
  useEffect(() => {
    if (!blocked) void queue.flush();
  }, [blocked, queue]);
  usePendingSave(`画布位置:${projectId}`, queue.flush);
  return (viewport: Viewport) => queue.update(viewport);
}
