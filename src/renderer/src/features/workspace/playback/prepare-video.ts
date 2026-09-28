/** Resolve only once a frame can be displayed; metadata alone is not enough. */
export function prepareVideo(
  video: HTMLVideoElement,
  url: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const frameCallbacks =
      typeof video.requestVideoFrameCallback === 'function';
    let finished = false;
    let videoFrame: number | undefined;
    let paintFrame: number | undefined;
    let decodedFrame: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(decodedFrame);
      if (videoFrame !== undefined) video.cancelVideoFrameCallback(videoFrame);
      if (paintFrame !== undefined) cancelAnimationFrame(paintFrame);
      video.removeEventListener('loadeddata', loaded);
      video.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const aborted = () => finish(new DOMException('Cancelled', 'AbortError'));
    const failed = () => {
      if (video.error) finish(new Error('Video unavailable'));
    };
    const loaded = () => {
      if (video.readyState < 2 || finished) return;
      // Electron can suppress frame callbacks for an invisible, paused video.
      // loadeddata also guarantees a decoded current frame. Give painting a
      // turn when possible, with a bounded fallback for occluded windows.
      paintFrame = requestAnimationFrame(() => {
        paintFrame = requestAnimationFrame(() => finish());
      });
      decodedFrame = setTimeout(() => finish(), 100);
    };
    const timeout = setTimeout(
      () => finish(new Error('Video load timeout')),
      15_000,
    );
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    video.pause();
    video.muted = true;
    video.preload = 'auto';
    video.addEventListener('loadeddata', loaded);
    video.addEventListener('error', failed);
    video.src = url;
    video.load();
    if (frameCallbacks) {
      videoFrame = video.requestVideoFrameCallback(() => finish());
    }
  });
}
