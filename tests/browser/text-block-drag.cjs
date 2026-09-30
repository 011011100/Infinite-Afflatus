// Run against an existing pnpm dev server; never opens a user project or starts a server.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require('node:fs');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = resolve(__dirname, '../..');
const scratch = mkdtempSync(join(root, 'src/renderer/.text-drag-test-'));
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/text-block-drag.fixture.tsx"></script></body></html>`,
);
app.once('will-quit', () => rmSync(scratch, { recursive: true, force: true }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1300,
    height: 900,
    title: '文本拖动回归（隔离测试）',
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  const wc = win.webContents;
  // Hidden macOS windows stop compositor frames during holds. Capture keeps the
  // real CSS animations advancing without displaying or focusing a second app.
  let painting = false;
  let ready = false;
  let failed = false;
  const paint = setInterval(async () => {
    if (!ready || painting || wc.isDestroyed()) return;
    painting = true;
    try {
      await wc.capturePage();
    } catch {
      // Navigation or closing can dispose the compositor surface mid-capture.
    } finally {
      painting = false;
    }
  }, 32);
  const run = (expression) => wc.executeJavaScript(expression);
  const screenshot = async (name) => {
    const directory = process.env.AFFLATUS_TEST_SCREENSHOTS;
    if (!directory) return;
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `${name}.png`),
      (await wc.capturePage()).toPNG(),
    );
  };
  const state = () =>
    run(`JSON.parse(document.querySelector('#saved-state').textContent)`);
  const order = () =>
    run(
      `[...document.querySelectorAll('[data-text-block]')].map(e => e.dataset.textBlock)`,
    );
  const dragging = () =>
    run(
      `document.querySelector('.group-text-stack').dataset.dragging === 'true'`,
    );
  const rect = (selector) =>
    run(
      `(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`,
    );
  const send = (type, p) =>
    wc.sendInputEvent({
      type,
      x: Math.round(p.x),
      y: Math.round(p.y),
      button: 'left',
      clickCount: 1,
      ...(type === 'mouseMove' ? { modifiers: ['leftButtonDown'] } : {}),
    });
  const load = async (count = 3) => {
    ready = false;
    await win.loadURL(
      `http://127.0.0.1:5173/${basename(scratch)}/index.html?count=${count}`,
    );
    for (let i = 0; i < 50; i++) {
      if (await run(`!!document.querySelector('[data-text-block]')`)) break;
      await sleep(100);
    }
    ready = true;
    await sleep(400); // Allow the real foreground entry animation to finish.
    assert.equal((await order()).length, count);
    await run(
      `window.dragTrace=[]; ['gotpointercapture','lostpointercapture'].forEach(type => document.addEventListener(type, e => window.dragTrace.push({type,buttons:e.buttons,target:e.target.className}),true));`,
    );
  };
  const grab = async (id, wait = true) => {
    const r = await rect(`[data-text-block="${id}"] .group-text-grip`);
    const p = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    send('mouseDown', p);
    if (wait) {
      await sleep(800);
      assert.equal(await dragging(), true, 'long hold lifts block');
    }
    return p;
  };
  const move = async (from, to, steps = 12) => {
    for (let i = 1; i <= steps; i++) {
      send('mouseMove', {
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      });
      await sleep(25);
    }
  };
  const release = async (p) => {
    send('mouseUp', p);
    await sleep(240);
  };
  const savedOrder = async () =>
    (await state()).filter((n) => n.groupId === 'group').map((n) => n.id);
  const noPrematureLoss = async () =>
    assert.equal(
      await run(
        `window.dragTrace.some(e => e.type === 'lostpointercapture' && e.buttons === 1)`,
      ),
      false,
      'moving a block must not cancel pointer capture',
    );
  const original = ['text-1', 'text-2', 'text-3'];
  try {
    await load();
    assert.equal(
      await run(
        `document.querySelector('.material-arc-heading').textContent.includes('参考素材')`,
      ),
      false,
    );
    let p = await grab('text-1', false);
    await sleep(60);
    assert.equal(
      await run(`!!document.querySelector('.text-block-hold')`),
      false,
    );
    await sleep(220);
    const progress = () =>
      run(
        `parseFloat(getComputedStyle(document.querySelector('.text-block-hold .hold-progress')).strokeDashoffset)`,
      );
    const earlyProgress = await progress();
    assert.ok(
      earlyProgress > 0 && earlyProgress < 100,
      'hold shows a partially filled ring',
    );
    assert.equal(await dragging(), false);
    await screenshot('hold-progress');
    await sleep(150);
    assert.ok(
      (await progress()) < earlyProgress - 10,
      'ring fills while the pointer stays down',
    );
    await release(p);
    assert.equal(
      await run(`!!document.querySelector('.text-block-hold')`),
      false,
    );
    assert.equal(await dragging(), false);
    assert.deepEqual(await savedOrder(), original);
    console.log(
      'PASS delayed hold ring advances and cancellation fades it out without lifting',
    );

    const first = await rect('[data-text-block="text-1"]');
    const second = await rect('[data-text-block="text-2"]');
    p = await grab('text-1');
    let to = { x: p.x, y: p.y + second.y - first.y + 12 };
    await move(p, to);
    const expected = ['text-2', 'text-1', 'text-3'];
    assert.equal(await dragging(), true);
    assert.deepEqual(await order(), expected);
    // Moving neither the pointer nor scroll must not reorder again as FLIP finishes.
    await sleep(240);
    send('mouseMove', to);
    await sleep(100);
    assert.deepEqual(await order(), expected);
    await noPrematureLoss();
    await release(to);
    assert.deepEqual(await savedOrder(), expected);
    assert.equal(
      (await state()).find((n) => n.id === 'text-1').text,
      '独立文本 1',
    );
    console.log(
      'PASS downward drag, stable preview, capture retained, independent content saved',
    );

    const nowFirst = await rect('[data-text-block="text-1"]');
    const nowSecond = await rect('[data-text-block="text-2"]');
    p = await grab('text-1');
    to = { x: p.x, y: p.y + nowSecond.y - nowFirst.y - 10 };
    await move(p, to);
    assert.deepEqual(await order(), original);
    await move(to, p); // Reverse direction without releasing.
    assert.deepEqual(await order(), expected);
    await move(p, to);
    await release(to);
    assert.deepEqual(await savedOrder(), original);
    console.log('PASS upward drag and direction reversal in one held gesture');

    p = await grab('text-1', false);
    to = { x: p.x, y: p.y + 30 };
    await move(p, to, 2);
    await sleep(800);
    assert.equal(await dragging(), false);
    await release(to);
    assert.deepEqual(await savedOrder(), original);
    p = await grab('text-1');
    await release(p);
    assert.deepEqual(await savedOrder(), original);
    console.log('PASS early movement and stationary hold do not change order');

    p = await grab('text-1');
    to = { x: p.x, y: p.y + second.y - first.y + 12 };
    await move(p, to);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await release(to);
    assert.deepEqual(await savedOrder(), original);
    assert.equal(await run(`document.querySelector('dialog').open`), true);
    assert.equal(await dragging(), false);
    console.log(
      'PASS Escape cancels a reordered preview without closing the editor',
    );

    p = await grab('text-2');
    const surface = await rect('.group-text-stack');
    to = { x: surface.x - 50, y: p.y };
    await move(p, to);
    assert.equal(
      await run(`document.querySelector('.group-text-lift').dataset.outside`),
      'true',
    );
    assert.equal(
      await run(
        `document.querySelector('.text-block-drop-feedback').dataset.outside`,
      ),
      'true',
    );
    await screenshot('drop-outside');
    await move(to, p);
    assert.equal(
      await run(
        `document.querySelector('.text-block-drop-feedback').dataset.outside`,
      ),
      'false',
    );
    await release(p);
    assert.deepEqual(await savedOrder(), original);
    p = await grab('text-2');
    to = { x: surface.x - 50, y: p.y };
    await move(p, to);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await release(to);
    assert.deepEqual(await savedOrder(), original);
    assert.equal(
      await run(
        `document.querySelector('.text-block-drop-feedback').dataset.open`,
      ),
      'false',
    );
    console.log(
      'PASS moving outside then back and Escape both cancel detachment',
    );

    p = await grab('text-2');
    to = { x: surface.x - 50, y: p.y };
    await move(p, to);
    await release(to);
    assert.equal(
      (await state()).find((n) => n.id === 'text-2').groupId,
      undefined,
    );
    assert.equal(
      (await state()).find((n) => n.id === 'text-2').text,
      '独立文本 2',
    );
    assert.deepEqual(await savedOrder(), ['text-1', 'text-3']);
    assert.equal(
      await run(
        `document.querySelector('.text-block-drop-feedback').dataset.complete`,
      ),
      'true',
    );
    assert.equal(await run(`document.querySelector('dialog').open`), true);
    await screenshot('returned-to-canvas');
    const view = await rect('.text-block-drop-feedback button');
    to = { x: view.x + view.width / 2, y: view.y + view.height / 2 };
    send('mouseDown', to);
    await release(to);
    assert.equal(await run(`!!document.querySelector('dialog[open]')`), false);
    const reopen = await rect('#reopen');
    to = { x: reopen.x + reopen.width / 2, y: reopen.y + reopen.height / 2 };
    send('mouseDown', to);
    await release(to);
    await sleep(400);
    assert.deepEqual(await order(), ['text-1', 'text-3']);
    console.log(
      'PASS drag out shows confirmation, View closes editor, detached content and remaining members persist',
    );

    await load(8);
    p = await grab('text-1');
    const list = await rect('.group-text-list');
    to = { x: p.x, y: list.y + list.height - 6 };
    await move(p, to);
    await sleep(1000);
    const scroll = await run(
      `document.querySelector('.group-text-list').scrollTop`,
    );
    assert.ok(scroll > 200, 'holding at the edge continues scrolling');
    assert.equal(await dragging(), true);
    const preview = await order();
    await noPrematureLoss();
    await release(to);
    assert.deepEqual(await savedOrder(), preview);
    assert.ok(preview.indexOf('text-1') >= 3);
    console.log(
      'PASS long-list autoscroll and drop commit without losing the drag',
    );
  } catch (error) {
    failed = true;
    console.error(error);
    await screenshot('failure');
    console.error(
      await run(
        `({holding:document.querySelector('[data-holding="true"]')?.dataset.textBlock, dragging:document.querySelector('.group-text-stack')?.dataset.dragging, outside:document.querySelector('.group-text-lift')?.dataset.outside})`,
      ),
    );
  } finally {
    clearInterval(paint);
    win.destroy();
    rmSync(scratch, { recursive: true, force: true });
    app.exit(failed ? 1 : 0);
  }
});
