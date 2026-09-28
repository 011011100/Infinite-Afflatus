import type { ClipTrim } from '../../../../../shared/canvas/trim';
import { prepareVideo } from './prepare-video';
import { seekVideo } from './seek-video';

export type PlaybackState = {
  index: number;
  pending: number | null;
  error: string | null;
  time: number;
  playing: boolean;
};

type Slot = 0 | 1;

type Buffer = {
  index: number;
  used: boolean;
  start: number;
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
  private state: PlaybackState = {
    index: 0,
    pending: null,
    error: null,
    time: 0,
    playing: false,
  };
  private ranges: ClipTrim[] = [];
  private jump = new AbortController();
  private clock: ReturnType<typeof setTimeout> | undefined;
  private wantsPlay = false;
  private preferences = { volume: 1, muted: false, rate: 1 };
  private removeListeners: (() => void)[] = [];

  constructor(
    private videos: [HTMLVideoElement, HTMLVideoElement],
    private sources: string[],
    private changed: (state: PlaybackState) => void,
    private prepare = prepareVideo,
    private seekFrame = seekVideo,
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
        if (
          this.active === slot &&
          this.state.pending === null &&
          this.wantsPlay
        )
          this.advance();
      };
      const error = () => {
        if (this.active === slot && video.error && !this.closed)
          this.update({ error: unavailable });
      };
      video.addEventListener('timeupdate', this.tick);
      video.addEventListener('volumechange', preferences);
      video.addEventListener('ratechange', preferences);
      video.addEventListener('ended', ended);
      video.addEventListener('error', error);
      this.removeListeners.push(() => {
        video.removeEventListener('timeupdate', this.tick);
        video.removeEventListener('volumechange', preferences);
        video.removeEventListener('ratechange', preferences);
        video.removeEventListener('ended', ended);
        video.removeEventListener('error', error);
      });
    });
  }

  setRanges(ranges: ClipTrim[]): void {
    this.ranges = ranges;
    if (this.active !== null && this.state.pending === null) {
      const range = ranges[this.state.index];
      const time = this.videos[this.active].currentTime;
      if (range && (time < range.start || time > range.end))
        void this.select(
          this.state.index,
          Math.max(range.start, Math.min(time, range.end)),
          false,
        );
      else this.preloadNext();
    }
  }

  pause(): void {
    this.wantsPlay = false;
    clearTimeout(this.clock);
    this.videos.forEach((video) => {
      video.pause();
    });
    this.update({ playing: false });
  }

  toggle(): void {
    if (this.wantsPlay) {
      this.pause();
      return;
    }
    const range = this.ranges[this.state.index];
    if (
      range &&
      this.state.index === this.sources.length - 1 &&
      this.state.time >= range.end - 0.02
    )
      void this.select(0, this.ranges[0]?.start, true);
    else
      void this.select(this.state.pending ?? this.state.index, undefined, true);
  }

  setMuted(muted: boolean): void {
    this.preferences.muted = muted;
    if (this.active !== null) this.videos[this.active].muted = muted;
  }

  private advance(): void {
    if (this.state.index + 1 < this.sources.length)
      void this.select(this.state.index + 1, undefined, true);
    else {
      this.pause();
      const end = this.ranges[this.state.index]?.end;
      if (end !== undefined) this.update({ time: end });
    }
  }

  private tick = (): void => {
    clearTimeout(this.clock);
    if (this.closed || this.active === null || this.state.pending !== null)
      return;
    const video = this.videos[this.active];
    const range = this.ranges[this.state.index];
    if (this.wantsPlay && range && video.currentTime >= range.end - 0.015) {
      this.advance();
      return;
    }
    this.update({ time: video.currentTime });
    if (this.wantsPlay) this.clock = setTimeout(this.tick, 30);
  };

  private preloadNext(): void {
    if (this.active !== null && this.state.index + 1 < this.sources.length)
      this.load(this.active === 0 ? 1 : 0, this.state.index + 1);
  }

  async select(index: number, time?: number, autoplay = true): Promise<void> {
    if (this.closed || !this.sources[index]) return;
    const version = ++this.version;
    this.jump.abort();
    this.jump = new AbortController();
    const signal = this.jump.signal;
    this.wantsPlay = autoplay;
    clearTimeout(this.clock);
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
    this.update({ pending: index, error: null, playing: false });
    // Selecting the displayed clip cancels a pending jump without reloading it.
    const slot =
      this.active !== null && this.state.index === index
        ? this.active
        : this.active === 0
          ? 1
          : 0;
    const buffer = this.load(slot, index);
    let ready = await buffer.ready;
    if (this.closed || version !== this.version) return;
    if (ready && time !== undefined) {
      try {
        await this.seekFrame(this.videos[slot], time, signal);
      } catch {
        ready = false;
      }
    }
    if (this.closed || version !== this.version) return;
    if (!ready) {
      this.wantsPlay = false;
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
    this.update({
      index,
      pending: null,
      error: null,
      time: video.currentTime,
      playing: this.wantsPlay,
    });
    if (this.wantsPlay) this.play(video, version);
    // Only the next clip is prepared; the old slot is now safely out of view.
    this.preloadNext();
  }

  private load(slot: Slot, index: number): Buffer {
    const source = this.sources[index];
    if (!source) throw new RangeError('Unknown video index');
    const existing = this.buffers[slot];
    if (
      existing?.index === index &&
      !existing.abort.signal.aborted &&
      (slot === this.active ||
        existing.start === (this.ranges[index]?.start ?? 0)) &&
      (slot === this.active || !existing.used)
    )
      return existing;
    existing?.abort.abort();
    const abort = new AbortController();
    const buffer: Buffer = {
      index,
      used: false,
      start: this.ranges[index]?.start ?? 0,
      abort,
      ready: this.prepare(this.videos[slot], source, abort.signal)
        .then(() =>
          this.seekFrame(
            this.videos[slot],
            this.ranges[index]?.start ?? 0,
            abort.signal,
          ),
        )
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
    const playing = video.play();
    this.tick();
    void playing.catch((error: unknown) => {
      if (this.closed || version !== this.version) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.pause();
      this.update({ error: '自动播放未能开始，请点击播放按钮重试。' });
    });
  }

  private show(slot: Slot, visible: boolean): void {
    const video = this.videos[slot];
    video.style.opacity = visible ? '1' : '0';
    video.style.pointerEvents = visible ? 'auto' : 'none';
    video.controls = false;
    video.inert = !visible;
    video.setAttribute('aria-hidden', String(!visible));
  }

  private update(state: Partial<PlaybackState>): void {
    this.state = { ...this.state, ...state };
    this.changed(this.state);
  }

  /** Release both decoders and pending work when leaving the editor. */
  stop(): void {
    this.closed = true;
    this.wantsPlay = false;
    clearTimeout(this.clock);
    this.jump.abort();
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
