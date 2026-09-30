import { prepareVideo } from '../playback/prepare-video';
import { seekVideo } from '../playback/seek-video';
import type { FilmstripRequest } from './filmstrip-cache';

/** Independent of the playback buffers: sampling must never seek the visible video. */
export class FilmstripDecoder {
  private video: HTMLVideoElement | null = null;
  private source: string | null = null;

  async decode(
    request: FilmstripRequest,
    signal: AbortSignal,
  ): Promise<HTMLCanvasElement> {
    signal.throwIfAborted();
    const video = this.video ?? document.createElement('video');
    this.video = video;
    if (this.source !== request.source) {
      this.source = null;
      await prepareVideo(video, request.source, signal);
      signal.throwIfAborted();
      this.source = request.source;
    }
    await seekVideo(
      video,
      Math.min(request.time, Math.max(0, video.duration - 0.05)),
      signal,
    );
    signal.throwIfAborted();
    const image = document.createElement('canvas');
    const scale = Math.min(192 / video.videoWidth, 128 / video.videoHeight, 1);
    image.width = Math.max(1, Math.round(video.videoWidth * scale));
    image.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = image.getContext('2d');
    if (!context || !video.videoWidth) throw new Error('无法读取轨道缩略图');
    // Drawing is allowed for local-origin media; never export/read tainted pixels.
    context.drawImage(video, 0, 0, image.width, image.height);
    return image;
  }

  dispose(): void {
    this.video?.pause();
    this.video?.removeAttribute('src');
    this.video?.load();
    this.video = null;
    this.source = null;
  }
}
