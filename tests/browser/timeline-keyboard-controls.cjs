// Real React timeline, native keyboard/mouse input, scrolling and filmstrip decoding.
// All three assets use the same public synthetic one-second video.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow, protocol } = require('electron');
const root = resolve(__dirname, '../..');
const origin = process.env.AFFLATUS_FIXTURE_ORIGIN;
if (!origin) throw new Error('Use the isolated fixture runner');
const scratch =
  process.env.AFFLATUS_FIXTURE_SCRATCH ??
  mkdtempSync(join(root, 'src/renderer/.timeline-keyboard-controls-'));
const profile =
  process.env.AFFLATUS_FIXTURE_PROFILE ??
  mkdtempSync(join(tmpdir(), 'afflatus-timeline-keyboard-controls-'));
app.setPath('userData', profile);
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'afflatus-media',
    privileges: { standard: true, secure: true, stream: true },
  },
]);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>时间轨道键盘回归</title></head><body><div id="root"></div><script>window.timelineInputEvents=[];for(const type of ['keydown','keyup','click'])window.addEventListener(type,event=>timelineInputEvents.push({type,key:event.key,detail:event.detail,trusted:event.isTrusted,target:event.target?.getAttribute('aria-label'),active:document.activeElement?.getAttribute('aria-label')}),true)</script><script type="module" src="/@fs/${root}/tests/browser/timeline-keyboard-controls.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const video = require('./thumbnail-fixture-video.cjs');
  protocol.handle(
    'afflatus-media',
    () =>
      new Response(video, {
        headers: {
          'Content-Type': 'video/mp4',
          'Access-Control-Allow-Origin': '*',
        },
      }),
  );
  const win = new BrowserWindow({
    width: 1100,
    height: 650,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const run = (source) => win.webContents.executeJavaScript(source);
  const errors = [];
  const nativeFocusEvents = [];
  const beforeInputEvents = [];
  const started = Date.now();
  let focusedTarget = 'null';
  const nativeFocus = () => ({
    windowFocused: win.isFocused(),
    contentsFocused: win.webContents.isFocused(),
    visible: win.isVisible(),
    loading: win.webContents.isLoadingMainFrame(),
  });
  const recordFocus = (type, target) =>
    nativeFocusEvents.push({
      atMs: Date.now() - started,
      type,
      target,
      ...nativeFocus(),
    });
  for (const event of ['focus', 'blur']) {
    win.on(event, () => recordFocus(`window-${event}`));
    win.webContents.on(event, () => recordFocus(`contents-${event}`));
  }
  win.webContents.on('before-input-event', (_event, input) => {
    beforeInputEvents.push({
      atMs: Date.now() - started,
      type: input.type,
      key: input.key,
      code: input.code,
      repeat: input.isAutoRepeat,
      ...nativeFocus(),
    });
  });
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const wait = async (source, label) => {
    for (let i = 0; i < 300; i++) {
      if (await run(source)) return;
      await sleep(20);
    }
    throw Error(`Timed out: ${label}`);
  };
  const second = 'document.querySelector("[data-timeline-clip=clip-2] button")';
  const scroll =
    'document.querySelector("section[aria-label=组合时间轨道] > div")';
  const state = () => run('timelineControls.state()');
  const painted = () =>
    run(
      'new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(null))))',
    );
  const focusTarget = async (target, label) => {
    focusedTarget = target;
    recordFocus('request', label);
    // A new document can report DOM focus before the macOS app is active.
    // Activate only this fixture, then establish focus before injecting a key.
    app.focus({ steal: true });
    win.focus();
    win.webContents.focus();
    await run(`${target}.focus({preventScroll:true})`);
    let stable = 0;
    for (let i = 0; i < 300; i++) {
      const domFocused = await run(
        `document.hasFocus() && document.activeElement===${target}`,
      );
      if (
        domFocused &&
        win.isFocused() &&
        win.webContents.isFocused() &&
        !win.webContents.isLoadingMainFrame()
      ) {
        if (++stable === 3) {
          recordFocus('stable', label);
          return;
        }
        await painted();
      } else {
        stable = 0;
        await sleep(20);
      }
    }
    throw Error(`Timed out: ${label} owns stable native and DOM focus`);
  };
  const focus = () => focusTarget(second, 'second clip');
  const key = async (keyCode) => {
    const previous = (await state()).events.length;
    const nativeKey = keyCode === 'Enter' ? 'Return' : keyCode;
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: nativeKey });
    win.webContents.sendInputEvent({
      type: 'char',
      keyCode: keyCode === 'Enter' ? '\r' : ' ',
    });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: nativeKey });
    await wait(
      `timelineControls.state().events.length===${previous + 2}`,
      `${keyCode} selects and seeks once`,
    );
  };
  const assertStart = async (playing) => {
    const result = await state();
    assert.equal(result.selected, 1);
    assert.equal(result.time, 0.4);
    assert.equal(result.sourceTime, 0.6);
    assert.equal(result.playing, playing);
    assert.deepEqual(result.events.slice(-2), [
      { type: 'select', value: 1 },
      { type: 'seek', value: 0.4 },
    ]);
  };
  let failed = false;
  try {
    await win.loadURL(`${origin}/${basename(scratch)}/index.html`);
    await wait('typeof timelineControls!=="undefined"', 'timeline mounted');
    await focus();
    await key('Enter');
    await assertStart(false);
    console.log(
      'PASS Enter selects trimmed clip 2 then seeks its combination offset, preserving pause and source in-point',
    );

    await run('timelineControls.configure({time:1.2,selected:2,playing:true})');
    await wait('timelineControls.state().playing', 'playing state set');
    await focus();
    await key('Space');
    await assertStart(true);
    console.log(
      'PASS Space activates clip 2 exactly once without toggling existing playback',
    );

    await run(
      'timelineControls.configure({time:1.2,selected:2,playing:false,zoom:8})',
    );
    await wait('timelineControls.state().zoom===8', 'zoomed timeline');
    await run(`${scroll}.scrollLeft=600`);
    await wait(`${scroll}.scrollLeft>500`, 'horizontal scroll applied');
    await focus();
    assert.equal(
      await run(
        `(()=>{const r=${second}.getBoundingClientRect();const s=${scroll}.getBoundingClientRect();return r.right<s.left+32})()`,
      ),
      true,
    );
    await key('Enter');
    await assertStart(false);
    await wait(
      `${scroll}.scrollLeft<100`,
      'keyboard reveals offscreen clip start',
    );
    const visible = await run(
      `(()=>{const r=${second}.getBoundingClientRect();const s=${scroll}.getBoundingClientRect();return r.left>=s.left+31&&r.left<s.right-32})()`,
    );
    assert.equal(visible, true);
    console.log(
      'PASS zoomed, horizontally clipped keyboard activation reveals the clip at its combination start',
    );

    const point = await run(
      `(()=>{const r=${second}.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`,
    );
    const beforeClick = (await state()).events.length;
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...point,
    });
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      ...point,
    });
    await wait(
      `timelineControls.state().events.length===${beforeClick + 2}`,
      'mouse selection and seek',
    );
    const pointer = await state();
    assert.equal(pointer.selected, 1);
    assert.ok(
      Math.abs(pointer.time - 0.55) < 0.005,
      `actual pointer midpoint ${pointer.time}`,
    );
    assert.equal(pointer.events.at(-1).final, true);
    assert.equal(pointer.playing, false);
    console.log(
      'PASS real mouse midpoint still seeks the clicked position, not the clip start',
    );

    await run(
      'timelineControls.configure({disabled:true,time:1.2,selected:2})',
    );
    await wait('timelineControls.state().disabled', 'trim edit lock set');
    await focus();
    await key('Space');
    await assertStart(false);
    const final = await state();
    assert.equal(final.mutations, 0);
    assert.deepEqual(
      final.clips.map(({ range }) => range),
      [
        { start: 0.1, end: 0.5 },
        { start: 0.6, end: 0.9 },
        { start: 0, end: 1 },
      ],
    );
    assert.equal(
      await run(
        'document.querySelectorAll("button[aria-label^=选择片段]").length',
      ),
      3,
    );
    assert.equal(
      await run('document.querySelectorAll("button[aria-label*=播放]").length'),
      0,
    );
    await sleep(200);
    assert.deepEqual(errors, []);
    console.log(
      'PASS locked trimming still permits keyboard navigation; no trim/gesture mutation or extra playback controls; renderer console empty',
    );

    await win.loadURL(`${origin}/${basename(scratch)}/index.html?editor`);
    await wait(
      'typeof editorCapture!=="undefined"&&editorCapture().pending===null&&!editorCapture().error',
      'real editor playback loaded',
    );
    await run('prepareEditorCapture()');
    await wait(
      'editorCapture().pending===null&&!editorCapture().error&&!editorCapture().playing&&Math.abs(editorCapture().time)<0.001',
      'real controller paused and sought to the combination start',
    );
    for (const [label, target] of [
      ['播放位置', 0.1],
      ['播放头', 0.2],
    ]) {
      await focusTarget(
        `document.querySelector('[role=slider][aria-label=${label}]')`,
        label,
      );
      const before = await run('timelineInputEvents.length');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
      await wait(
        `timelineInputEvents.slice(${before}).some(event=>event.type==='keydown'&&event.key==='ArrowRight')`,
        `${label} receives native keydown`,
      );
      const delivered = await run(
        `timelineInputEvents.slice(${before}).find(event=>event.type==='keydown'&&event.key==='ArrowRight')`,
      );
      assert.equal(delivered.trusted, true);
      assert.equal(delivered.target, label);
      assert.equal(delivered.active, label);
      await wait(
        `Math.abs(editorCapture().time-${target})<0.001`,
        `${label} receives native arrow through editor capture`,
      );
    }
    await focus();
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: ' ' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await wait(
      'editorCapture().selected===1&&Math.abs(editorCapture().time-0.4)<0.001',
      'full editor Space selects clip 2',
    );
    const editor = await run('editorCapture()');
    assert.deepEqual(editor.seeks, [0.1, 0.2, 0.4]);
    assert.equal(editor.playing, false);
    assert.equal(editor.mutations, 0);
    assert.equal(editor.error, null);
    assert.deepEqual(errors, []);
    console.log(
      'PASS actual editor capture handler lets timeline and playhead arrows through; Space selects the trimmed clip without toggling real playback',
    );
  } catch (error) {
    failed = true;
    console.error(error);
    console.error('renderer errors', errors);
    console.error('native focus events', nativeFocusEvents);
    console.error('before-input events', beforeInputEvents);
    console.error('focus diagnostic', {
      ...nativeFocus(),
      dom: await run(
        `(()=>{const target=${focusedTarget};return {focused:document.hasFocus(),active:document.activeElement?.outerHTML.slice(0,600),target:target?.outerHTML.slice(0,600),inert:!!target?.closest('[inert]')}})()`,
      ),
    });
    console.error(
      'timeline state',
      await run(
        'typeof timelineControls!=="undefined"?timelineControls.state():editorCapture()',
      ),
    );
    console.error('native input', await run('window.timelineInputEvents'));
  } finally {
    win.destroy();
    try {
      if (!process.env.AFFLATUS_FIXTURE_SCRATCH)
        rmSync(scratch, { recursive: true, force: true });
      if (!process.env.AFFLATUS_FIXTURE_PROFILE)
        rmSync(profile, { recursive: true, force: true });
    } finally {
      app.exit(failed ? 1 : 0);
    }
  }
});
