/** Seek a prepared buffer before revealing it, including hidden Electron videos. */
export function seekVideo(
  video: HTMLVideoElement,
  time: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (
    Math.abs(video.currentTime - time) < 0.015 &&
    !video.seeking &&
    video.readyState >= 2
  )
    return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener('seeked', ready);
      video.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const ready = () => {
      if (!video.seeking && video.readyState >= 2) {
        // Some protocol responses report seeked while clamping currentTime to 0.
        // Never reveal/play that frame as if the retained in-point was reached.
        finish(
          Math.abs(video.currentTime - time) <= 0.05
            ? undefined
            : new Error('视频未能定位到指定时间'),
        );
      }
    };
    const failed = () => finish(new Error('无法定位视频画面'));
    const aborted = () => finish(new DOMException('Cancelled', 'AbortError'));
    const timeout = setTimeout(failed, 15000);
    video.addEventListener('seeked', ready);
    video.addEventListener('error', failed);
    signal.addEventListener('abort', aborted, { once: true });
    try {
      video.currentTime = time;
      ready();
    } catch {
      failed();
    }
  });
}
