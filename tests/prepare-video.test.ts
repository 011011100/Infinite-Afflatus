/// <reference lib="dom" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareVideo } from '../src/renderer/src/features/workspace/playback/prepare-video';

// Model an occluded window: animation and video frame callbacks do not fire.
Object.assign(globalThis, {
  requestAnimationFrame: () => 1,
  cancelAnimationFrame: () => {},
});

class LoadingVideo extends EventTarget {
  src = '';
  muted = false;
  preload = '';
  readyState = 0;
  error: { message: string } | null = null;
  frame: (() => void) | undefined;
  cancelled = false;
  loads = 0;
  pause() {}
  load() {
    this.loads++;
  }
  requestVideoFrameCallback(callback: () => void) {
    this.frame = callback;
    return 1;
  }
  cancelVideoFrameCallback() {
    this.cancelled = true;
  }
}

test('frame callback completes preparation before the decoded-frame fallback', async () => {
  const video = new LoadingVideo();
  let ready = false;
  const prepared = prepareVideo(
    video as unknown as HTMLVideoElement,
    'clip',
    new AbortController().signal,
  ).then(() => {
    ready = true;
  });
  video.readyState = 2;
  video.dispatchEvent(new Event('loadeddata'));
  await Promise.resolve();
  assert.equal(ready, false);
  video.frame?.();
  await prepared;
  assert.equal(ready, true);
  assert.equal(video.cancelled, true);
  assert.equal(video.muted, true);
});

test('aborting preparation removes callbacks and never waits for the load timeout', async () => {
  const video = new LoadingVideo();
  const abort = new AbortController();
  const prepared = prepareVideo(
    video as unknown as HTMLVideoElement,
    'clip',
    abort.signal,
  );
  const rejected = assert.rejects(prepared, { name: 'AbortError' });
  abort.abort();
  await rejected;
  assert.equal(video.cancelled, true);
  video.frame?.();
  const alreadyAborted = new LoadingVideo();
  await assert.rejects(
    prepareVideo(
      alreadyAborted as unknown as HTMLVideoElement,
      'clip',
      abort.signal,
    ),
    { name: 'AbortError' },
  );
  assert.equal(alreadyAborted.loads, 0);
});

test('unreadable media rejects preparation and clears its frame callback', async () => {
  const video = new LoadingVideo();
  const prepared = prepareVideo(
    video as unknown as HTMLVideoElement,
    'clip',
    new AbortController().signal,
  );
  const rejected = assert.rejects(prepared, /Video unavailable/);
  video.error = { message: 'unsupported' };
  video.dispatchEvent(new Event('error'));
  await rejected;
  assert.equal(video.cancelled, true);
});

test('a decoded first frame is usable even when Electron suppresses compositor callbacks', async () => {
  const video = new LoadingVideo();
  const prepared = prepareVideo(
    video as unknown as HTMLVideoElement,
    'clip',
    new AbortController().signal,
  );
  video.readyState = 4;
  video.dispatchEvent(new Event('loadeddata'));
  await prepared;
  assert.equal(video.cancelled, true);
});
