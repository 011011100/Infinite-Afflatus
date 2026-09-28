/// <reference lib="dom" />
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type PlaybackState,
  SequencePlayback,
} from '../src/renderer/src/features/workspace/playback/sequence-playback';

class Video extends EventTarget {
  style = { opacity: '', pointerEvents: '' };
  paused = true;
  muted = false;
  volume = 1;
  playbackRate = 1;
  controls = false;
  inert = false;
  src = '';
  error = null;
  plays = 0;
  playFailure: Error | undefined;
  setAttribute() {}
  removeAttribute() {
    this.src = '';
  }
  load() {}
  pause() {
    this.paused = true;
  }
  play(): Promise<void> {
    this.plays++;
    this.paused = false;
    return this.playFailure
      ? Promise.reject(this.playFailure)
      : Promise.resolve();
  }
}

function setup() {
  const videos = [new Video(), new Video()] as const;
  const loads: {
    video: HTMLVideoElement;
    source: string;
    signal: AbortSignal;
    ready: () => void;
    fail: () => void;
  }[] = [];
  let state: PlaybackState | undefined;
  const playback = new SequencePlayback(
    videos as unknown as [HTMLVideoElement, HTMLVideoElement],
    ['blue', 'green', 'orange', 'purple'],
    (next) => {
      state = next;
    },
    (video, source, signal) => {
      video.pause();
      video.muted = true;
      video.src = source;
      return new Promise((resolve, reject) => {
        loads.push({
          video,
          source,
          signal,
          ready: resolve,
          fail: () => reject(new Error('decode failed')),
        });
      });
    },
  );
  return { videos, loads, playback, state: () => state };
}

const flush = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

test('preloads only the next clip and retains the old frame until the next is ready', async () => {
  const { videos, loads, playback, state } = setup();
  const first = playback.select(0);
  loads[0]?.ready();
  await first;
  assert.deepEqual(
    loads.map((load) => load.source),
    ['blue', 'green'],
  );
  assert.equal(videos[0].style.opacity, '1');
  assert.equal(videos[1].paused, true);
  assert.equal(videos[1].muted, true);
  const next = playback.select(1);
  assert.equal(videos[0].style.opacity, '1');
  assert.equal(state()?.index, 0);
  loads[1]?.ready();
  await next;
  assert.equal(state()?.index, 1);
  assert.equal(videos[1].style.opacity, '1');
  assert.equal(videos[0].style.opacity, '0');
  assert.equal(videos.filter((video) => !video.paused).length, 1);
  assert.deepEqual(
    loads.map((load) => load.source),
    ['blue', 'green', 'orange'],
  );
  playback.dispose();
});

test('rapid manual jumps ignore late loads and cancel superseded preloads', async () => {
  const { videos, loads, playback, state } = setup();
  const first = playback.select(0);
  loads[0]?.ready();
  await first;
  const second = playback.select(1);
  const third = playback.select(2);
  assert.equal(loads[1]?.signal.aborted, true);
  loads[1]?.ready();
  await second;
  assert.equal(state()?.index, 0);
  assert.equal(videos[0].style.opacity, '1');
  loads[2]?.ready();
  await third;
  assert.equal(state()?.index, 2);
  assert.equal(videos[1].plays, 1);
  playback.dispose();
});

test('automatic advance preserves volume, mute and rate; final clip stays on its last frame', async () => {
  const { videos, loads, playback, state } = setup();
  const first = playback.select(0);
  loads[0]?.ready();
  await first;
  videos[0].volume = 0.3;
  videos[0].muted = true;
  videos[0].playbackRate = 1.5;
  loads[1]?.ready();
  await flush();
  videos[0].dispatchEvent(new Event('ended'));
  await flush();
  assert.equal(state()?.index, 1);
  assert.equal(videos[1].volume, 0.3);
  assert.equal(videos[1].muted, true);
  assert.equal(videos[1].playbackRate, 1.5);
  const last = playback.select(3);
  loads.at(-1)?.ready();
  await last;
  const count = loads.length;
  videos[0].dispatchEvent(new Event('ended'));
  await flush();
  assert.equal(state()?.index, 3);
  assert.equal(loads.length, count);
  assert.equal(videos[0].style.opacity, '1');
  playback.dispose();
});

test('failed jumps keep the displayed frame, allow retry and recover controls', async () => {
  const { videos, loads, playback, state } = setup();
  const first = playback.select(0);
  loads[0]?.ready();
  await first;
  const second = playback.select(1);
  loads[1]?.fail();
  await second;
  assert.equal(state()?.index, 0);
  assert.ok(state()?.error);
  assert.equal(videos[0].style.opacity, '1');
  assert.equal(videos[0].controls, true);
  const retry = playback.select(1);
  loads[2]?.ready();
  await retry;
  assert.equal(state()?.index, 1);
  assert.equal(state()?.error, null);
  playback.dispose();
});

test('returning to the visible clip cancels a pending jump without reloading the frame', async () => {
  const { videos, loads, playback, state } = setup();
  const first = playback.select(0);
  loads[0]?.ready();
  await first;
  const pending = playback.select(2);
  await playback.select(0);
  loads[2]?.ready();
  await pending;
  assert.equal(state()?.index, 0);
  assert.equal(videos[0].plays, 2);
  assert.equal(loads.filter((load) => load.source === 'blue').length, 1);
  playback.dispose();
});

test('closing during loading prevents playback and state changes after dismissal', async () => {
  const { videos, loads, playback, state } = setup();
  const pending = playback.select(0);
  playback.stop();
  const before = state();
  loads[0]?.ready();
  await pending;
  assert.equal(videos[0].plays, 0);
  assert.equal(state(), before);
  assert.equal(loads[0]?.signal.aborted, true);
  await playback.select(1);
  assert.equal(loads.length, 1);
  playback.dispose();
  assert.ok(videos.every((video) => video.paused && !video.src));
});

test('blocked autoplay leaves a ready frame and usable native play controls', async () => {
  const { videos, loads, playback, state } = setup();
  videos[0].playFailure = new DOMException('Not allowed', 'NotAllowedError');
  const first = playback.select(0);
  loads[0]?.ready();
  await first;
  await flush();
  assert.match(state()?.error ?? '', /自动播放/);
  assert.equal(videos[0].controls, true);
  assert.equal(videos[0].style.opacity, '1');
  playback.dispose();
});

test('jumping backwards re-prepares a previously played next clip from its start', async () => {
  const { loads, playback, state } = setup();
  const first = playback.select(0);
  loads[0]?.ready();
  await first;
  const orange = playback.select(2);
  loads.at(-1)?.ready();
  await orange;
  const green = playback.select(1);
  loads.at(-1)?.ready();
  await green;
  assert.equal(state()?.index, 1);
  assert.equal(loads.at(-1)?.source, 'orange');
  assert.equal(loads.filter((load) => load.source === 'orange').length, 2);
  playback.dispose();
});
