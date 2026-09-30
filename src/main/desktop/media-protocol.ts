import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { isId } from '../projects/project-service';
import { safeFile } from '../storage/files';
import type { Library } from '../storage/library';

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'afflatus-media',
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
      },
    },
  ]);
}

/** Only registered asset IDs resolve; the renderer cannot choose filesystem paths. */
export function serveProjectMedia(library: Library): void {
  protocol.handle('afflatus-media', async (request) => {
    try {
      const url = new URL(request.url);
      const [projectId, assetId, extra] = url.pathname.slice(1).split('/');
      if (
        !['asset', 'proxy'].includes(url.host) ||
        !isId(projectId) ||
        !isId(assetId) ||
        extra ||
        !['GET', 'HEAD'].includes(request.method)
      )
        return new Response(null, { status: 400 });
      const snapshot = await library.projects.open(projectId);
      const asset = snapshot.assets.find((item) => item.id === assetId);
      if (!asset) return new Response(null, { status: 404 });
      const root = dirname(await library.projects.databasePath(projectId));
      const file =
        url.host === 'proxy'
          ? await library.proxies.file(projectId, assetId)
          : await safeFile(root, asset.relativePath);
      if (!file) return new Response(null, { status: 404 });
      return net.fetch(pathToFileURL(file).toString(), {
        method: request.method,
        headers: request.headers,
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
