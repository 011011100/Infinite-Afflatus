import { useRef, useState } from 'react';
import type { Viewport } from '../../../../shared/models';
import { LatestSaveQueue } from '../lifecycle/latest-save-queue';
import { usePendingSave } from '../lifecycle/use-pending-save';

export function useViewportSave(
  projectId: string,
  report: (reason: unknown) => void,
) {
  const reportError = useRef(report);
  reportError.current = report;
  const [queue] = useState(
    () =>
      new LatestSaveQueue<Viewport>(async (viewport) => {
        try {
          await window.desktop.saveViewport(projectId, viewport);
        } catch (error) {
          reportError.current(error);
          throw error;
        }
      }),
  );
  usePendingSave(`画布位置:${projectId}`, queue.flush);
  return (viewport: Viewport) => queue.update(viewport);
}
