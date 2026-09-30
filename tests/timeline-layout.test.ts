import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundScroll,
  timelineLayout,
} from '../src/renderer/src/features/workspace/editor/timeline-layout';

test('a 20-second retained sequence fits the viewport independently of source in-points', () => {
  const fit = timelineLayout(1216, 20, 1, 0, 20);
  assert.equal(fit.width, 1216);
  assert.equal(fit.maxScroll, 0);
  assert.equal(fit.minScroll, 0);
  assert.equal(10 * fit.scale, 608);
  const smaller = timelineLayout(1216, 20, 0.5, 0, 20);
  assert.equal(smaller.width, 1216);
  assert.equal(smaller.maxScroll, 0);
});

test('zoomed scrolling ends at the retained sequence and clamps out-of-range input', () => {
  const zoomed = timelineLayout(1216, 20, 3, 0, 20);
  assert.ok(Math.abs(zoomed.width - 3648) < 0.001);
  assert.ok(
    Math.abs(boundScroll(99999, zoomed.minScroll, zoomed.maxScroll) - 2432) <
      0.001,
  );
  assert.equal(boundScroll(-500, zoomed.minScroll, zoomed.maxScroll), 0);
});

test('trim gestures can hold the scroll extent, then release the surplus', () => {
  const original = timelineLayout(900, 20, 3, 0, 20);
  const dragging = timelineLayout(900, 20, 3, 0, 5, original.width);
  assert.equal(dragging.width, original.width);
  const released = timelineLayout(900, 20, 3, 0, 5);
  assert.equal(released.width, 900);
  assert.equal(
    boundScroll(original.maxScroll, released.minScroll, released.maxScroll),
    0,
  );
});

test('large head trims cannot be scrolled into a wholly empty leading viewport', () => {
  const layout = timelineLayout(900, 20, 1, 30, 5);
  assert.equal(layout.minScroll, 675);
  assert.ok(30 * layout.scale - layout.minScroll < 900);
  assert.equal(
    boundScroll(0, layout.minScroll, layout.maxScroll),
    layout.minScroll,
  );
});
