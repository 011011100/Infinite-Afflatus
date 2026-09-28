/// <reference lib="dom" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { seekVideo } from '../src/renderer/src/features/workspace/playback/seek-video';

class Seekable extends EventTarget {
  time = 0;
  seeking = false;
  readyState = 4;
  get currentTime() {
    return this.time;
  }
  set currentTime(value: number) {
    this.time = value;
    this.seeking = true;
  }
  finish() {
    this.seeking = false;
    this.dispatchEvent(new Event('seeked'));
  }
  asVideo() {
    return this as unknown as HTMLVideoElement;
  }
}
test('a seek resolves only after the requested source frame has decoded', async () => {
  const video = new Seekable();
  let resolved = false;
  const waiting = seekVideo(
    video.asVideo(),
    1.5,
    new AbortController().signal,
  ).then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(video.currentTime, 1.5);
  video.finish();
  await waiting;
  assert.equal(resolved, true);
});
test('rapid scrubbing cancels an old seek and does not cancel the new one', async () => {
  const video = new Seekable();
  const abort = new AbortController();
  const old = seekVideo(video.asVideo(), 1, abort.signal);
  abort.abort();
  const next = seekVideo(video.asVideo(), 2, new AbortController().signal);
  await assert.rejects(old, { name: 'AbortError' });
  video.finish();
  await next;
  assert.equal(video.currentTime, 2);
});
test('a ready frame at the same position is reused without another seek', async () => {
  const video = new Seekable();
  await seekVideo(video.asVideo(), 0, new AbortController().signal);
  assert.equal(video.seeking, false);
});
