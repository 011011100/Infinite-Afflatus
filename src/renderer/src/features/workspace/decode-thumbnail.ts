export interface ThumbnailFrame {
  image: HTMLCanvasElement;
  duration: number | null;
}

/** Decode once, then release the video decoder. No file access or pixel export. */
export function decodeThumbnail(
  source: string,
  signal: AbortSignal,
): Promise<ThumbnailFrame> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      video.onloadeddata = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
    };
    const fail = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const abort = () => fail(signal.reason);
    const timeout = setTimeout(
      () => fail(new Error('读取视频缩略图超时')),
      15_000,
    );
    signal.addEventListener('abort', abort, { once: true });
    video.onloadeddata = () => {
      try {
        const image = document.createElement('canvas');
        const scale = Math.min(
          576 / video.videoWidth,
          324 / video.videoHeight,
          1,
        );
        image.width = Math.max(1, Math.round(video.videoWidth * scale));
        image.height = Math.max(1, Math.round(video.videoHeight * scale));
        const context = image.getContext('2d');
        if (!context || !video.videoWidth || !video.videoHeight)
          throw new Error('无法读取视频画面');
        // A local media canvas may be origin-tainted. Drawing it into another
        // canvas is allowed; never read/export its pixels or weaken media CORS.
        context.drawImage(video, 0, 0, image.width, image.height);
        const duration = Number.isFinite(video.duration)
          ? video.duration
          : null;
        cleanup();
        resolve({ image, duration });
      } catch (error) {
        fail(error);
      }
    };
    video.onerror = () => fail(new Error('无法读取视频缩略图'));
    video.muted = true;
    video.preload = 'auto';
    video.src = source;
  });
}
