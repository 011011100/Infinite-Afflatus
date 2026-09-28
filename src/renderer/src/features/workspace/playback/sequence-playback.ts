import { prepareVideo } from './prepare-video';

export type PlaybackState = {
  index: number;
  pending: number | null;
  error: string | null;
};

type Slot = 0 | 1;

type Buffer = {
  index: number;
  used: boolean;
  abort: AbortController;
  ready: Promise<boolean>;
};

const unavailable =
  '这段视频暂时无法播放，请检查文件或编码格式。可以选择其他片段继续预览。';

/** Owns two reusable media elements. React owns the surrounding controls only. */
export class SequencePlayback {
  private active: Slot | null = null;
  private buffers: (Buffer | undefined)[] = [];
  private version = 0;
  private closed = false;
  private state: PlaybackState = { index: 0, pending: null, error: null };
  private preferences = { volume: 1, muted: false, rate: 1 };
  private removeListeners: (() => void)[] = [];

  constructor(
    private videos: [HTMLVideoElement, HTMLVideoElement],
    private sources: string[],
    private changed: (state: PlaybackState) => void,
    private prepare = prepareVideo,
  ) {
    ([0, 1] as const).forEach((slot) => {
      const video = videos[slot];
      this.show(slot, false);
      const preferences = () => {
        if (this.active !== slot || this.closed) return;
        this.preferences = {
          volume: video.volume,
          muted: video.muted,
          rate: video.playbackRate,
        };
      };
      const ended = () => {
        if (this.active === slot && this.state.pending === null)
          this.select(this.state.index + 1);
      };
      const error = () => {
        if (this.active === slot && video.error && !this.closed)
          this.update({ error: unavailable });
      };
      video.addEventListener('volumechange', preferences);
      video.addEventListener('ratechange', preferences);
      video.addEventListener('ended', ended);
      video.addEventListener('error', error);
      this.removeListeners.push(() => {
        video.removeEventListener('volumechange', preferences);
        video.removeEventListener('ratechange', preferences);
        video.removeEventListener('ended', ended);
        video.removeEventListener('error', error);
      });
    });
  }

  async select(index: number): Promise<void> {
    if (this.closed || !this.sources[index]) return;
    const version = ++this.version;
    const current = this.active === null ? undefined : this.videos[this.active];
    if (current) {
      this.preferences = {
        volume: current.volume,
        muted: current.muted,
        rate: current.playbackRate,
      };
      current.pause();
      current.controls = false;
    }
    this.update({ pending: index, error: null });
    // Selecting the displayed clip cancels a pending jump without reloading it.
    const slot =
      this.active !== null && this.state.index === index
        ? this.active
        : this.active === 0
          ? 1
          : 0;
    const buffer = this.load(slot, index);
    const ready = await buffer.ready;
    if (this.closed || version !== this.version) return;
    if (!ready) {
      if (current) current.controls = true;
      this.update({ pending: null, error: unavailable });
      return;
    }

    const video = this.videos[slot];
    buffer.used = true;
    const previous = this.active;
    this.active = slot;
    video.volume = this.preferences.volume;
    video.playbackRate = this.preferences.rate;
    video.muted = this.preferences.muted;
    this.show(slot, true);
    if (previous !== null && previous !== slot) {
      this.show(previous, false);
      this.videos[previous].muted = true;
    }
    this.update({ index, pending: null, error: null });
    this.play(video, version);
    // Only the next clip is prepared; the old slot is now safely out of view.
    if (index + 1 < this.sources.length)
      this.load(slot === 0 ? 1 : 0, index + 1);
  }

  private load(slot: Slot, index: number): Buffer {
    const source = this.sources[index];
    if (!source) throw new RangeError('Unknown video index');
    const existing = this.buffers[slot];
    if (
      existing?.index === index &&
      !existing.abort.signal.aborted &&
      (slot === this.active || !existing.used)
    )
      return existing;
    existing?.abort.abort();
    const abort = new AbortController();
    const buffer: Buffer = {
      index,
      used: false,
      abort,
      ready: this.prepare(this.videos[slot], source, abort.signal)
        .then(() => true)
        .catch(() => {
          // A failed speculative preload is reported only if selected.
          abort.abort();
          return false;
        }),
    };
    this.buffers[slot] = buffer;
    return buffer;
  }

  private play(video: HTMLVideoElement, version: number): void {
    void video.play().catch((error: unknown) => {
      if (this.closed || version !== this.version) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.update({ error: '自动播放未能开始，请点击视频中的播放按钮。' });
    });
  }

  private show(slot: Slot, visible: boolean): void {
    const video = this.videos[slot];
    video.style.opacity = visible ? '1' : '0';
    video.style.pointerEvents = visible ? 'auto' : 'none';
    video.controls = visible;
    video.inert = !visible;
    video.setAttribute('aria-hidden', String(!visible));
  }

  private update(state: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...state };
    this.changed(this.state);
  }

  /** Called at the start of modal dismissal, before its exit animation. */
  stop(): void {
    this.closed = true;
    this.version++;
    this.buffers.forEach((buffer) => {
      buffer?.abort.abort();
    });
    this.videos.forEach((video) => {
      video.pause();
      video.muted = true;
      video.controls = false;
    });
  }

  dispose(): void {
    this.stop();
    this.removeListeners.forEach((remove) => {
      remove();
    });
    this.videos.forEach((video) => {
      video.removeAttribute('src');
      video.load();
    });
  }
}
