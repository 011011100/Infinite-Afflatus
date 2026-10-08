import type { DesktopBridge } from '../../../../../shared/desktop';

/** Own proxy preparation and its editor lease across asynchronous mounts/unmounts. */
export function prepareSequenceProxies(
  desktop: Pick<
    DesktopBridge,
    'acquireProxyUsage' | 'releaseProxyUsage' | 'prepareProxy'
  >,
  projectId: string,
  assetIds: string[],
  ready: (index: number, url: string) => void,
  finished: (ready: boolean) => void,
): () => void {
  let disposed = false;
  let usage: string | null = null;
  const release = () => {
    if (!usage) return;
    const token = usage;
    usage = null;
    void desktop.releaseProxyUsage(token).catch(() => {
      // Main-process window teardown also releases every remaining lease.
    });
  };
  void (async () => {
    try {
      usage = await desktop.acquireProxyUsage(projectId, assetIds);
    } catch {
      if (!disposed) finished(false);
      return;
    }
    if (disposed) {
      release();
      return;
    }
    const results = await Promise.all(
      assetIds.map(async (id, index) => {
        try {
          const result = await desktop.prepareProxy(projectId, id);
          if (result.ready && !disposed)
            ready(index, `afflatus-media://proxy/${projectId}/${id}`);
          return result.ready;
        } catch {
          return false;
        }
      }),
    );
    if (!disposed) finished(results.every(Boolean));
  })();
  return () => {
    disposed = true;
    release();
  };
}
