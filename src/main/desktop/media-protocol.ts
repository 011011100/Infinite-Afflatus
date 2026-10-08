import { protocol } from 'electron';
import { mediaFileResponse } from '../media/file-response';
import { isId } from '../projects/project-service';
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
      if (url.host === 'proxy') {
        const leased = await library.proxies.acquireFile(projectId, assetId);
        if (!leased) return new Response(null, { status: 404 });
        return await mediaFileResponse(leased.file, request, leased.release);
      }
      const media = await library.referenceReads.acquire(
        projectId,
        assetId,
        undefined,
        request.signal,
      );
      if (!media) return new Response(null, { status: 404 });
      return await mediaFileResponse(media, request);
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
