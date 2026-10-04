export interface VideoMetadata {
  duration: number | null;
  width: number;
  height: number;
}

/** Read only container metadata; no first-frame canvas or retained video decoder. */
export function readVideoMetadata(
  source: string,
  signal: AbortSignal,
): Promise<VideoMetadata> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
    };
    const fail = (reason: unknown) => {
      cleanup();
      reject(reason);
    };
    const abort = () => fail(signal.reason);
    const timeout = setTimeout(
      () => fail(new Error('读取视频信息超时')),
      15_000,
    );
    signal.addEventListener('abort', abort, { once: true });
    video.onloadedmetadata = () => {
      if (!video.videoWidth || !video.videoHeight) {
        fail(new Error('无法读取视频尺寸'));
        return;
      }
      const metadata = {
        duration: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth,
        height: video.videoHeight,
      };
      cleanup();
      resolve(metadata);
    };
    video.onerror = () => fail(new Error('无法读取视频信息'));
    video.muted = true;
    video.preload = 'metadata';
    video.src = source;
  });
}
