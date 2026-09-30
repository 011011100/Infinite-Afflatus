import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RightSelection } from '../src/shared/interaction/right-selection';

const origin = { x: 200, y: 100 };

test('right click defers an early contextmenu until release', () => {
  const gesture = new RightSelection();
  gesture.start(1, origin, ['a'], false);
  assert.equal(gesture.contextMenu(), 'defer');
  assert.equal(gesture.move(1, { x: 202, y: 103 }), null);
  assert.deepEqual(gesture.release(1, origin), {
    selection: null,
    openMenu: true,
  });
  assert.equal(gesture.active, false);
});

test('right click allows a contextmenu delivered after release', () => {
  const gesture = new RightSelection();
  gesture.start(1, origin, [], false);
  assert.deepEqual(gesture.release(1, origin), {
    selection: null,
    openMenu: false,
  });
  assert.equal(gesture.contextMenu(), 'open');
});

test('right drag selects in reverse direction and never opens the menu', () => {
  const gesture = new RightSelection();
  gesture.start(1, origin, ['a'], false);
  assert.equal(gesture.contextMenu(), 'defer');
  assert.deepEqual(gesture.move(1, { x: 120, y: 20 }), {
    box: { x: 120, y: 20, width: 80, height: 80 },
    before: ['a'],
    additive: false,
  });
  assert.equal(gesture.contextMenu(), 'suppress');
  const result = gesture.release(1, { x: 100, y: 10 });
  assert.equal(result?.openMenu, false);
  assert.deepEqual(result?.selection?.box, {
    x: 100,
    y: 10,
    width: 100,
    height: 90,
  });
  assert.equal(gesture.contextMenu(), 'suppress');
  gesture.start(1, origin, ['b'], false);
  gesture.release(1, origin);
  assert.equal(gesture.contextMenu(), 'open');
});

test('release includes final movement even without a pointermove event', () => {
  const gesture = new RightSelection();
  gesture.start(1, origin, [], false);
  assert.ok(gesture.release(1, { x: 400, y: 300 })?.selection);
  assert.equal(gesture.contextMenu(), 'suppress');
});

test('returning to the origin after dragging does not become a context click', () => {
  const gesture = new RightSelection();
  gesture.start(1, origin, [], false);
  gesture.move(1, { x: 220, y: 120 });
  assert.equal(gesture.release(1, origin)?.openMenu, false);
  assert.equal(gesture.contextMenu(), 'suppress');
});

test('additive selection retains an independent snapshot throughout the drag', () => {
  const gesture = new RightSelection();
  const selected = ['a'];
  gesture.start(1, origin, selected, true);
  selected.push('b');
  const selection = gesture.move(1, { x: 400, y: 300 });
  assert.equal(selection?.additive, true);
  assert.deepEqual(selection?.before, ['a']);
});

test('foreign pointer events cannot end or change the active gesture', () => {
  const gesture = new RightSelection();
  gesture.start(1, origin, [], false);
  assert.equal(gesture.move(2, { x: 400, y: 300 }), null);
  assert.equal(gesture.release(2, origin), null);
  assert.equal(gesture.active, true);
  assert.equal(gesture.release(1, origin)?.selection, null);
});

test('cancelling restores pre-drag selection and suppresses the pending menu', () => {
  const gesture = new RightSelection();
  gesture.start(1, origin, ['a'], false);
  gesture.move(1, { x: 400, y: 300 });
  assert.deepEqual(gesture.cancel(), ['a']);
  assert.equal(gesture.active, false);
  assert.equal(gesture.release(1, origin), null);
  assert.equal(gesture.contextMenu(), 'suppress');
  assert.equal(gesture.cancel(), null);
  gesture.resetMenu();
  assert.equal(gesture.contextMenu(), 'open');
});
