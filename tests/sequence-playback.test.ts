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
  currentTime = 0;
  seeking = false;
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

function setup(
  seek?: (
    video: HTMLVideoElement,
    time: number,
    signal: AbortSignal,
  ) => Promise<void>,
) {
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
    seek,
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
  assert.equal(videos[0].controls, false);
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

test('blocked autoplay leaves a ready frame and usable external playback controls', async () => {
  const { videos, loads, playback, state } = setup();
  videos[0].playFailure = new DOMException('Not allowed', 'NotAllowedError');
  const first = playback.select(0);
  loads[0]?.ready();
  await first;
  await flush();
  assert.match(state()?.error ?? '', /自动播放/);
  assert.equal(videos[0].controls, false);
  assert.equal(videos[0].style.opacity, '1');
  playback.dispose();
});

test('jumping backwards reuses a previously played next clip without reloading its source', async () => {
  const { loads, playback, state, videos } = setup(async (video, time) => {
    video.currentTime = time;
  });
  const first = playback.select(0);
  loads[0]?.ready();
  await first;
  const orange = playback.select(2);
  loads.at(-1)?.ready();
  await orange;
  videos[1].currentTime = 2.5;
  const green = playback.select(1);
  loads.at(-1)?.ready();
  await green;
  assert.equal(state()?.index, 1);
  assert.equal(loads.filter((load) => load.source === 'orange').length, 1);
  const count = loads.length;
  await playback.select(2, undefined, false);
  assert.equal(state()?.index, 2);
  assert.equal(state()?.time, 0);
  assert.equal(loads.length, count);
  playback.dispose();
});

test('trimmed ranges seek before display, advance at out-point and finish at the final trimmed end', async () => {
  const videos = [new Video(), new Video()] as const;
  let state: PlaybackState | undefined;
  const seeked: number[] = [];
  const playback = new SequencePlayback(
    videos as unknown as [HTMLVideoElement, HTMLVideoElement],
    ['a', 'b'],
    (next) => {
      state = next;
    },
    async (video, source) => {
      video.src = source;
    },
    async (video, time) => {
      seeked.push(time);
      video.currentTime = time;
    },
  );
  playback.setRanges([
    { start: 1, end: 2 },
    { start: 2, end: 3 },
  ]);
  await playback.select(0);
  await flush();
  assert.equal(videos[0].currentTime, 1);
  assert.ok(seeked.includes(2));
  videos[0].currentTime = 2;
  videos[0].dispatchEvent(new Event('timeupdate'));
  await flush();
  assert.equal(state?.index, 1);
  assert.equal(videos[0].paused, true);
  assert.equal(videos[1].currentTime, 2);
  videos[1].currentTime = 3;
  videos[1].dispatchEvent(new Event('timeupdate'));
  assert.equal(state?.playing, false);
  assert.equal(state?.time, 3);
  assert.equal(videos[1].paused, true);
  playback.toggle();
  await flush();
  assert.equal(state?.index, 0);
  assert.equal(state?.playing, true);
  playback.dispose();
});

test('scrubbing stays paused and a pause during a pending seek prevents later autoplay', async () => {
  const { playback, videos, loads, state } = setup();
  const first = playback.select(0, 0, false);
  loads[0]?.ready();
  await first;
  assert.equal(state()?.playing, false);
  assert.equal(videos[0].plays, 0);
  const next = playback.select(1);
  playback.pause();
  loads[1]?.ready();
  await next;
  assert.equal(state()?.playing, false);
  assert.ok(videos.every((video) => video.paused));
  playback.dispose();
});

test('autoplay bounds explicit and resumed source positions to the retained range', async () => {
  const videos = [new Video(), new Video()] as const;
  const playback = new SequencePlayback(
    videos as unknown as [HTMLVideoElement, HTMLVideoElement],
    ['trimmed'],
    () => {},
    async (video, source) => {
      video.src = source;
    },
    async (video, time) => {
      video.currentTime = time;
    },
  );
  try {
    playback.setRanges([{ start: 20, end: 30 }]);
    await playback.select(0, 0, true);
    assert.equal(videos[0].currentTime, 20);
    assert.equal(videos[0].paused, false);
    // A trim preview may expose an earlier frame before the draft range updates.
    await playback.select(0, 15, false);
    assert.equal(videos[0].currentTime, 15);
    assert.equal(videos[0].paused, true);
    await playback.select(0, undefined, true);
    assert.equal(videos[0].currentTime, 20);
    await playback.select(0, 45, true);
    assert.equal(videos[0].currentTime, 30);
    assert.equal(videos[0].paused, true);
  } finally {
    playback.dispose();
  }
});

test('a burst of scrub targets finishes the current decode then seeks only the latest position', async () => {
  const decodes: { time: number; signal: AbortSignal; finish: () => void }[] =
    [];
  const { playback, loads, state, videos } = setup((video, time, signal) => {
    if (time === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      decodes.push({
        time,
        signal,
        finish: () => {
          video.currentTime = time;
          resolve();
        },
      });
    });
  });
  const first = playback.select(0, 0, false);
  loads[0]?.ready();
  await first;
  playback.seek(0, 1);
  await flush();
  for (let index = 2; index <= 80; index++) playback.seek(0, index / 10);
  assert.equal(decodes.length, 1);
  assert.equal(decodes[0]?.signal.aborted, false);
  assert.deepEqual(state()?.target, { index: 0, time: 8 });
  decodes[0]?.finish();
  await flush();
  assert.deepEqual(
    decodes.map((decode) => decode.time),
    [1, 8],
  );
  assert.equal(state()?.time, 1);
  assert.equal(state()?.target?.time, 8);
  decodes[1]?.finish();
  await flush();
  assert.equal(state()?.time, 8);
  assert.equal(state()?.target, null);
  assert.equal(loads.length, 1);
  assert.ok(videos.every((video) => video.paused));
  playback.dispose();
});

test('paused scrubbing back and forth retains both clips and their requested times', async () => {
  const { playback, loads, state } = setup(async (video, time) => {
    video.currentTime = time;
  });
  const first = playback.select(0, 0, false);
  loads[0]?.ready();
  await first;
  playback.seek(1, 2);
  loads[1]?.ready();
  await flush();
  for (let index = 0; index < 12; index++) {
    playback.seek(index % 2, 1 + index / 10);
    await flush();
    assert.equal(state()?.index, index % 2);
    assert.equal(state()?.time, 1 + index / 10);
  }
  assert.equal(loads.length, 2);
  assert.equal(state()?.target, null);
  playback.dispose();
});

test('changing clips supersedes a slow scrub load and late completion cannot clear the latest target', async () => {
  const { playback, loads, state } = setup(async (video, time) => {
    video.currentTime = time;
  });
  const first = playback.select(0, 0, false);
  loads[0]?.ready();
  await first;
  playback.seek(1, 1);
  playback.seek(1, 2);
  playback.seek(2, 3);
  assert.equal(loads[1]?.signal.aborted, true);
  loads[1]?.ready();
  await flush();
  assert.deepEqual(state()?.target, { index: 2, time: 3 });
  assert.equal(state()?.index, 0);
  loads[2]?.ready();
  await flush();
  assert.equal(state()?.index, 2);
  assert.equal(state()?.time, 3);
  assert.equal(state()?.target, null);
  playback.dispose();
});

test('play uses the latest queued time and closing prevents a queued seek from restarting', async () => {
  const { playback, loads, state, videos } = setup(async (video, time) => {
    video.currentTime = time;
  });
  const first = playback.select(0, 0, false);
  loads[0]?.ready();
  await first;
  playback.seek(1, 1);
  playback.seek(1, 2);
  playback.toggle();
  loads[1]?.ready();
  await flush();
  assert.equal(state()?.time, 2);
  assert.equal(state()?.playing, true);
  assert.equal(state()?.target, null);
  playback.seek(2, 3);
  playback.seek(2, 4);
  playback.stop();
  const before = state();
  loads.at(-1)?.ready();
  await flush();
  assert.equal(state(), before);
  assert.ok(videos.every((video) => video.paused));
  playback.dispose();
});

test('release immediately supersedes an obsolete decode without replaying queued positions', async () => {
  const decodes: { time: number; signal: AbortSignal; finish: () => void }[] =
    [];
  const { playback, loads, state } = setup((video, time, signal) => {
    if (time === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      decodes.push({
        time,
        signal,
        finish: () => {
          if (!signal.aborted) video.currentTime = time;
          resolve();
        },
      });
    });
  });
  const first = playback.select(0, 0, false);
  loads[0]?.ready();
  await first;
  playback.seek(0, 1);
  await flush();
  playback.seek(0, 2);
  playback.seek(0, 3, true);
  await flush();
  assert.equal(decodes[0]?.signal.aborted, true);
  assert.deepEqual(
    decodes.map((decode) => decode.time),
    [1, 3],
  );
  decodes[1]?.finish();
  await flush();
  decodes[0]?.finish();
  await flush();
  assert.equal(state()?.time, 3);
  assert.equal(state()?.target, null);
  assert.equal(decodes.length, 2);
  playback.dispose();
});
