import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(
  new URL('./browser/timeline-keyboard-controls.cjs', import.meta.url),
  'utf8',
);
const focus = source.match(
  / {2}const nativeFocus = ([\s\S]*?);\n {2}const recordFocus/,
);
const cleanup = source.match(/ {2}} finally \{\n([\s\S]*)\n {2}}\n}\);\s*$/);
assert.ok(focus, 'Update this test if focus diagnostics move');
assert.ok(cleanup, 'Update this test if fixture cleanup moves');

function diagnostic({
  windowDestroyed = false,
  contentsDestroyed = false,
} = {}) {
  const liveWindow = () => {
    assert.equal(
      windowDestroyed,
      false,
      'a destroyed window must not be queried',
    );
    return true;
  };
  const liveContents = () => {
    assert.equal(
      contentsDestroyed,
      false,
      'destroyed webContents must not be queried',
    );
    return true;
  };
  const win = {
    isDestroyed: () => windowDestroyed,
    isFocused: liveWindow,
    isVisible: liveWindow,
    get webContents() {
      liveWindow();
      return {
        isDestroyed: () => contentsDestroyed,
        isFocused: liveContents,
        isLoadingMainFrame: liveContents,
      };
    },
  };
  return runInNewContext(`(${focus[1]})()`, { win });
}

test('timeline focus diagnostics still report the live window and renderer', () => {
  const result = diagnostic();
  for (const field of [
    'windowFocused',
    'contentsFocused',
    'visible',
    'loading',
  ])
    assert.equal(result[field], true);
});

test('timeline blur diagnostics tolerate renderer destruction before window destruction', () => {
  const result = diagnostic({ contentsDestroyed: true });
  assert.equal(result.windowFocused, true);
  assert.equal(result.contentsFocused, false);
  assert.equal(result.loading, false);
});

test('timeline blur diagnostics never access a destroyed window', () => {
  const result = diagnostic({ windowDestroyed: true, contentsDestroyed: true });
  for (const field of [
    'windowFocused',
    'contentsFocused',
    'visible',
    'loading',
  ])
    assert.equal(result[field], false);
});

for (const initialFailure of [false, true]) {
  for (const destructionThrows of [false, true]) {
    test(`timeline teardown exits with the correct status: assertion failure=${initialFailure}, destruction failure=${destructionThrows}`, () => {
      const exits = [];
      const errors = [];
      runInNewContext(`let failed = ${initialFailure};\n${cleanup[1]}`, {
        win: {
          destroy() {
            if (destructionThrows)
              throw new Error('synthetic destroyed-object error');
          },
        },
        process: {
          env: {
            AFFLATUS_FIXTURE_SCRATCH: 'owned-by-runner',
            AFFLATUS_FIXTURE_PROFILE: 'owned-by-runner',
          },
        },
        app: { exit: (code) => exits.push(code) },
        console: { error: (...args) => errors.push(args) },
      });
      assert.deepEqual(exits, [initialFailure || destructionThrows ? 1 : 0]);
      assert.equal(errors.length, destructionThrows ? 1 : 0);
    });
  }
}
