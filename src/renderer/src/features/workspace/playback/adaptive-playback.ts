import type { ClipTrim } from '../../../../../shared/canvas/trim';
import { prepareVideo } from './prepare-video';
import type { SeekTarget } from './seek-scheduler';
import { seekVideo } from './seek-video';
import { type PlaybackState, SequencePlayback } from './sequence-playback';

type Videos = [HTMLVideoElement, HTMLVideoElement];
type Layer = 'original' | 'proxy';

/** Two reusable buffers per quality, with a frame-ready handoff (never a src swap). */
export class AdaptivePlayback {
  private original: SequencePlayback;
  private proxy: SequencePlayback;
  private proxySources: string[];
  private mode: Layer | 'restoring' = 'original';
  private visible: Layer = 'original';
  private wasPending: Record<Layer, boolean> = {
    original: false,
    proxy: false,
  };
  private intent: SeekTarget | null = null;
  private revision = 0;
  private closed = false;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private ranges: ClipTrim[] = [];
  private originalState: PlaybackState = {
    index: 0,
    time: 0,
    pending: null,
    playing: false,
    error: null,
    target: null,
  };
  private state = this.originalState;

  constructor(
    private originalVideos: Videos,
    private proxyVideos: Videos,
    sources: string[],
    private changed: (state: PlaybackState) => void,
    prepare = prepareVideo,
    seek = seekVideo,
    private dwellMs = 150,
  ) {
    this.proxySources = sources.map(() => '');
    this.original = new SequencePlayback(
      originalVideos,
      sources,
      (state) => {
        this.originalState = state;
        this.receive('original', state);
      },
      prepare,
      seek,
    );
    this.proxy = new SequencePlayback(
      proxyVideos,
      this.proxySources,
      (state) => this.receive('proxy', state),
      prepare,
      seek,
    );
    this.activate('original');
  }

  setProxy(index: number, url: string): void {
    if (this.closed) return;
    this.proxySources[index] = url;
    if (index === this.state.index)
      this.proxy.warm(index, this.ranges[index]?.start ?? 0);
  }

  setRanges(ranges: ClipTrim[]): void {
    this.ranges = ranges;
    this.original.setRanges(ranges, this.mode === 'original');
    this.proxy.setRanges(ranges);
  }

  seek(index: number, time: number, final = false): void {
    if (this.closed || !this.ranges[index] || !Number.isFinite(time)) return;
    const wasRestoring = this.mode === 'restoring';
    this.revision++;
    clearTimeout(this.idle);
    this.intent = { index, time };
    if (!this.proxySources[index]) {
      this.mode = 'original';
      if (wasRestoring) this.original.interrupt();
      this.proxy.interrupt();
      this.original.seek(index, time, final);
      return;
    }
    this.mode = 'proxy';
    // The HD decoder does no new seeking during continuous pointer movement.
    this.original.interrupt();
    this.emit({ ...this.state, playing: false, target: this.intent });
    this.proxy.seek(index, time, final);
    if (final) void this.restore(index, time, false);
    else
      this.idle = setTimeout(() => {
        void this.restore(index, time, false);
      }, this.dwellMs);
  }

  private receive(layer: Layer, state: PlaybackState): void {
    if (this.closed) return;
    const frameReady =
      this.wasPending[layer] && state.pending === null && !state.error;
    this.wasPending[layer] = state.pending !== null;
    if (
      layer === 'proxy' &&
      (this.mode === 'proxy' || this.mode === 'restoring')
    ) {
      if (state.error) {
        const target = this.intent;
        if (target && this.proxySources[target.index]) {
          this.proxySources[target.index] = '';
          clearTimeout(this.idle);
          void this.restore(target.index, target.time, false);
        }
        return;
      }
    } else if (layer !== this.mode) return;
    // A queued target/paused event is not a newly decoded frame. Keep the current
    // layer until the other controller finishes seeking, even if it has an old frame.
    if (this.visible !== layer && !frameReady) {
      this.emit({
        ...this.state,
        pending: state.pending,
        target: this.intent,
        playing: false,
      });
      return;
    }
    if (frameReady) this.activate(layer);
    if (
      this.mode !== 'restoring' &&
      state.pending === null &&
      state.target === null &&
      this.intent?.index === state.index &&
      Math.abs(this.intent.time - state.time) < 0.05
    )
      this.intent = null;
    this.emit({ ...state, target: this.intent ?? state.target });
  }

  private async restore(
    index: number,
    time: number | undefined,
    autoplay: boolean,
  ): Promise<void> {
    const revision = this.revision;
    this.mode = 'restoring';
    await this.original.select(index, time, autoplay);
    if (this.closed || revision !== this.revision) return;
    this.mode = 'original';
    this.intent = null;
    if (!this.originalState.error) this.activate('original');
    // A slow or failed original keeps the proxy frame visible, with retry available.
    this.emit(this.originalState);
  }

  async select(index: number, time?: number, autoplay = true): Promise<void> {
    if (this.closed) return;
    this.revision++;
    clearTimeout(this.idle);
    this.mode = 'restoring';
    this.intent = time === undefined ? null : { index, time };
    this.proxy.interrupt();
    await this.restore(index, time, autoplay);
  }

  toggle(): void {
    if (this.state.playing) {
      this.pause();
      return;
    }
    const target = this.intent ?? {
      index: this.state.index,
      time: this.state.time,
    };
    const last = this.ranges.length - 1;
    if (
      target.index === last &&
      target.time >= (this.ranges[last]?.end ?? Infinity) - 0.02
    )
      void this.select(0, this.ranges[0]?.start, true);
    else void this.select(target.index, target.time, true);
  }

  pause(): void {
    this.original.pause();
    this.proxy.pause();
  }
  setMuted(muted: boolean): void {
    this.original.setMuted(muted);
  }

  private activate(layer: Layer): void {
    this.visible = layer;
    this.originalVideos.forEach((video) => {
      video.style.visibility = layer === 'original' ? 'visible' : 'hidden';
    });
    this.proxyVideos.forEach((video) => {
      video.style.visibility = layer === 'proxy' ? 'visible' : 'hidden';
      video.muted = true;
    });
  }

  private emit(state: PlaybackState): void {
    this.state = state;
    this.changed(state);
  }

  stop(): void {
    this.closed = true;
    this.revision++;
    clearTimeout(this.idle);
    this.original.stop();
    this.proxy.stop();
  }
  dispose(): void {
    this.stop();
    this.original.dispose();
    this.proxy.dispose();
  }
}
