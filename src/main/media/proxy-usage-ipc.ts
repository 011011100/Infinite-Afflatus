import { randomUUID } from 'node:crypto';
import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop';
import { isId } from '../projects/project-service';
import type { WriteGate } from '../storage/write-gate';
import type { ProxyService } from './proxy-service';

/** Keep paused editors protected between media range requests; leases never persist. */
export function registerProxyUsageIpc(
  proxies: Pick<ProxyService, 'protect'>,
  gate: WriteGate,
  trustedWindow: (event: IpcMainInvokeEvent) => BrowserWindow,
): void {
  const leases = new Map<string, { owner: number; release: () => void }>();
  const revisions = new Map<number, number>();
  const windowFor = (event: IpcMainInvokeEvent) => {
    const window = trustedWindow(event);
    const contents = window.webContents;
    if (!revisions.has(contents.id)) {
      revisions.set(contents.id, 0);
      const clear = () => {
        revisions.set(contents.id, (revisions.get(contents.id) ?? 0) + 1);
        for (const [token, lease] of leases) {
          if (lease.owner !== contents.id) continue;
          leases.delete(token);
          lease.release();
        }
      };
      contents.once('destroyed', clear);
      contents.on('render-process-gone', clear);
      contents.on(
        'did-start-navigation',
        (_event, _url, inPlace, mainFrame) => {
          if (mainFrame && !inPlace) clear();
        },
      );
    }
    return window;
  };
  ipcMain.handle(
    IPC_CHANNELS.acquireProxyUsage,
    async (event, projectId: unknown, assetIds: unknown) => {
      const owner = windowFor(event).webContents.id;
      const revision = revisions.get(owner);
      if (
        !isId(projectId) ||
        !Array.isArray(assetIds) ||
        assetIds.length === 0 ||
        assetIds.length > 10_000 ||
        !assetIds.every(isId)
      )
        throw new Error('无效的预览素材');
      if (
        [...leases.values()].filter((lease) => lease.owner === owner).length >=
        64
      )
        throw new Error('预览会话过多，请关闭后重新打开');
      const release = await gate.run(async () => {
        if (
          windowFor(event).webContents.id !== owner ||
          revision !== revisions.get(owner)
        )
          throw new Error('预览窗口已变化');
        return proxies.protect(projectId, [...new Set(assetIds)]);
      });
      try {
        if (
          windowFor(event).webContents.id !== owner ||
          revision !== revisions.get(owner)
        )
          throw new Error('预览窗口已变化');
        const token = randomUUID();
        leases.set(token, { owner, release });
        return token;
      } catch (error) {
        release();
        throw error;
      }
    },
  );
  ipcMain.handle(IPC_CHANNELS.releaseProxyUsage, (event, token: unknown) => {
    const owner = windowFor(event).webContents.id;
    if (typeof token !== 'string') throw new Error('无效的预览会话');
    const lease = leases.get(token);
    if (!lease) return;
    if (lease.owner !== owner) throw new Error('预览会话不属于当前窗口');
    leases.delete(token);
    lease.release();
  });
}
