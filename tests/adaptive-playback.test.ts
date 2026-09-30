/// <reference lib="dom" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptivePlayback } from '../src/renderer/src/features/workspace/playback/adaptive-playback';
import type { PlaybackState } from '../src/renderer/src/features/workspace/playback/sequence-playback';

class Video extends EventTarget {
  style = { opacity: '', pointerEvents: '', visibility: '' };
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
  setAttribute() {}
  removeAttribute() {
    this.src = '';
  }
  load() {}
  pause() {
    this.paused = true;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('play during initial loading starts at the retained in-point and its clock advances', async () => {
  const videos = [new Video(), new Video(), new Video(), new Video()] as const;
  let ready = () => {};
  let state: PlaybackState | undefined;
  const player = new AdaptivePlayback(
    videos.slice(0, 2) as unknown as [HTMLVideoElement, HTMLVideoElement],
    videos.slice(2) as unknown as [HTMLVideoElement, HTMLVideoElement],
    ['original-a'],
    (next) => {
      state = next;
    },
    (video, source) => {
      video.src = source;
      return new Promise<void>((resolve) => {
        ready = resolve;
      });
    },
    async (video, time) => {
      video.currentTime = time;
    },
  );
  try {
    player.setRanges([{ start: 20, end: 30 }]);
    const initial = player.select(0);
    player.toggle();
    ready();
    await initial;
    await flush();
    assert.equal(videos[0]?.currentTime, 20);
    assert.equal(state?.time, 20);
    assert.equal(state?.playing, true);
    assert.equal(state?.target, null);
    videos[0].currentTime = 21;
    videos[0]?.dispatchEvent(new Event('timeupdate'));
    assert.equal(state?.time, 21);
    assert.equal(state?.playing, true);
    player.pause();
    assert.ok(videos.every((video) => video.paused));
    assert.equal(state?.playing, false);
  } finally {
    player.dispose();
  }
});

async function fixture(dwellMs = 60_000) {
  const originals = [new Video(), new Video()];
  const proxies = [new Video(), new Video()];
  const decodes: {
    source: string;
    time: number;
    signal: AbortSignal;
    finish: () => void;
  }[] = [];
  let slow = false;
  let slowProxy = false;
  let failedProxy = false;
  let state: PlaybackState | undefined;
  const player = new AdaptivePlayback(
    originals as unknown as [HTMLVideoElement, HTMLVideoElement],
    proxies as unknown as [HTMLVideoElement, HTMLVideoElement],
    ['original-a', 'original-b'],
    (next) => {
      state = next;
    },
    async (video, source) => {
      video.src = source;
    },
    async (video, time, signal) => {
      if (failedProxy && video.src.startsWith('proxy'))
        throw new Error('cache unreadable');
      if (
        time > 0 &&
        ((slow && video.src.startsWith('original')) ||
          (slowProxy && video.src.startsWith('proxy')))
      ) {
        await new Promise<void>((resolve) => {
          decodes.push({
            source: video.src,
            time,
            signal,
            finish: () => {
              if (!signal.aborted) video.currentTime = time;
              resolve();
            },
          });
        });
      } else {
        video.currentTime = time;
      }
    },
    dwellMs,
  );
  player.setRanges([
    { start: 0, end: 10 },
    { start: 1, end: 8 },
  ]);
  await player.select(0, 0, false);
  player.setProxy(0, 'proxy-a');
  player.setProxy(1, 'proxy-b');
  await flush();
  return {
    player,
    originals,
    proxies,
    decodes,
    state: () => state,
    slow: () => {
      slow = true;
    },
    slowProxy: () => {
      slowProxy = true;
    },
    failProxy: () => {
      failedProxy = true;
    },
  };
}

test('scrubbing decodes the proxy and retains it until the original final frame is ready', async () => {
  const f = await fixture();
  try {
    f.slow();
    f.player.seek(0, 2);
    await flush();
    assert.equal(f.originals[0]?.currentTime, 0);
    assert.equal(f.proxies[0]?.currentTime, 2);
    assert.equal(f.proxies[0]?.style.visibility, 'visible');
    assert.equal(f.originals[0]?.style.visibility, 'hidden');
    f.player.seek(0, 4, true);
    await flush();
    assert.equal(f.decodes.length, 1);
    assert.equal(f.proxies[0]?.currentTime, 4);
    assert.equal(f.proxies[0]?.style.visibility, 'visible');
    f.decodes[0]?.finish();
    await flush();
    assert.equal(f.originals[0]?.style.visibility, 'visible');
    assert.equal(f.proxies[0]?.style.visibility, 'hidden');
    assert.equal(f.state()?.time, 4);
    assert.equal(f.state()?.target, null);
    assert.ok([...f.originals, ...f.proxies].every((v) => v.paused));
  } finally {
    f.player.dispose();
  }
});

test('starting a new drag does not flash an old cached proxy frame before the new position decodes', async () => {
  const f = await fixture();
  try {
    f.player.seek(0, 2);
    await flush();
    f.player.seek(0, 4, true);
    await flush();
    assert.equal(f.originals[0]?.style.visibility, 'visible');
    f.slowProxy();
    f.player.seek(0, 7);
    await flush();
    assert.equal(f.originals[0]?.style.visibility, 'visible');
    assert.equal(f.proxies[0]?.style.visibility, 'hidden');
    assert.equal(f.state()?.target?.time, 7);
    f.decodes[0]?.finish();
    await flush();
    assert.equal(f.proxies[0]?.style.visibility, 'visible');
    assert.equal(f.state()?.time, 7);
  } finally {
    f.player.dispose();
  }
});

test('new input supersedes a slow original restore; late original frames cannot replace the new proxy', async () => {
  const f = await fixture();
  try {
    f.slow();
    f.player.seek(0, 2, true);
    await flush();
    f.player.seek(1, 6);
    await flush();
    assert.ok(f.decodes[0]?.signal.aborted);
    f.decodes[0]?.finish();
    await flush();
    assert.equal(f.state()?.index, 1);
    assert.equal(f.state()?.time, 6);
    assert.equal(f.originals[0]?.style.visibility, 'hidden');
    assert.ok(f.proxies.every((v) => v.muted));
  } finally {
    f.player.dispose();
  }
});

test('dwelling restores the original and closing prevents late work from changing the view', async () => {
  const f = await fixture(10);
  f.slow();
  f.player.seek(0, 3);
  await flush();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.decodes[0]?.time, 3);
  f.player.stop();
  const before = f.state();
  f.decodes[0]?.finish();
  await flush();
  assert.equal(f.state(), before);
  assert.ok(f.decodes[0]?.signal.aborted);
  f.player.dispose();
  assert.ok([...f.originals, ...f.proxies].every((v) => !v.src));
});

test('proxy errors fall back to the exact original position and playback uses original audio only', async () => {
  const f = await fixture();
  try {
    f.failProxy();
    f.player.seek(1, 5);
    await flush();
    await flush();
    assert.equal(f.state()?.time, 5);
    assert.equal(f.state()?.error, null);
    assert.equal(f.originals[0]?.style.visibility, 'visible');
    f.player.toggle();
    await flush();
    assert.equal(f.state()?.playing, true);
    assert.ok(f.proxies.every((v) => v.paused && v.muted));
    assert.equal(f.originals.filter((v) => !v.paused).length, 1);
  } finally {
    f.player.dispose();
  }
});
