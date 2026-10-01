// Isolated real-pointer regression; reuse the running Vite service and never open user projects.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require('node:fs');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = resolve(__dirname, '../..');
const scratch = mkdtempSync(join(root, 'src/renderer/.group-hover-test-'));
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/group-hover.fixture.tsx"></script></body></html>`,
);
app.once('will-quit', () => rmSync(scratch, { recursive: true, force: true }));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1300,
    height: 900,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  const wc = win.webContents;
  const run = (code) => wc.executeJavaScript(code);
  const errors = [];
  wc.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  let painting = false;
  const timer = setInterval(async () => {
    if (painting || wc.isDestroyed()) return;
    painting = true;
    try {
      await wc.capturePage();
    } catch {
      /* Surface may not exist while navigating. */
    } finally {
      painting = false;
    }
  }, 32);
  const state = () =>
    run('JSON.parse(document.querySelector("#state").textContent)');
  const node = (id) => `.react-flow__node[data-id="${id}"]`;
  const rect = (selector) =>
    run(
      `(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`,
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
  const move = async (from, to) => {
    for (let i = 1; i <= 8; i++) {
      send('mouseMove', {
        x: from.x + ((to.x - from.x) * i) / 8,
        y: from.y + ((to.y - from.y) * i) / 8,
      });
      await sleep(16);
    }
  };
  const destination = async (id = 'target') => {
    const r = await rect(node(id));
    return { x: r.x + 110, y: r.y + 110 };
  };
  const load = async (query = '') => {
    await win.loadURL(
      `http://127.0.0.1:5173/${basename(scratch)}/index.html${query}`,
    );
    for (let i = 0; i < 50; i++) {
      if (await run(`!!document.querySelector('${node('outside')}')`)) break;
      await sleep(100);
    }
    await sleep(300);
  };
  const grab = async () => {
    const r = await rect(`${node('outside')} .material-handle`);
    const from = { x: r.x + 20, y: r.y + 20 };
    send('mouseDown', from);
    const to = await destination();
    await move(from, to);
    return to;
  };
  const parent = async () =>
    (await state()).nodes.find((n) => n.id === 'outside').groupId;
  const screenshot = async (name) => {
    const dir = process.env.AFFLATUS_TEST_SCREENSHOTS;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), (await wc.capturePage()).toPNG());
  };
  let failed = false;
  try {
    await load();
    const before = await state();
    let p = await grab();
    await sleep(200);
    assert.equal(await parent(), undefined);
    assert.equal(
      await run('!!document.querySelector("[data-receiving=true]")'),
      true,
    );
    assert.equal(
      await run(
        '!!document.querySelector(".hold-feedback[data-open=true] .hold-progress")',
      ),
      true,
    );
    await screenshot('joining');
    await sleep(600);
    assert.equal(
      await parent(),
      undefined,
      'ready is confirmation only, not a join',
    );
    assert.equal(
      await run(
        'document.querySelector(".hold-feedback [role=status]").textContent',
      ),
      '松开合并，移动取消',
    );
    assert.equal(
      await run('!!document.querySelector(".hold-indicator[data-ready=true]")'),
      true,
    );
    await screenshot('ready-to-join');
    await sleep(800);
    assert.equal(
      await parent(),
      undefined,
      'holding the checkmark longer cannot join',
    );
    // Tiny pointer jitter uses the same five-screen-pixel tolerance as split.
    const jitter = { x: p.x + 3, y: p.y };
    send('mouseMove', jitter);
    send('mouseUp', jitter);
    await sleep(150);
    assert.equal(await parent(), 'target', 'only release confirms the join');
    const joined = await state();
    assert.deepEqual(joined.groups[0].position, before.groups[0].position);
    assert.deepEqual(joined.groups[0].parameters, before.groups[0].parameters);
    assert.deepEqual(
      joined.nodes.find((n) => n.id === 'member'),
      before.nodes.find((n) => n.id === 'member'),
    );
    assert.equal(
      await run('!!document.querySelector("[aria-label=视频生成组合编辑]")'),
      false,
    );
    const added = joined.nodes.find((n) => n.id === 'outside');
    const frame = await rect(node('target'));
    const card = await rect(node('outside'));
    assert.ok(Math.abs(card.x - frame.x - added.position.x) < 1);
    assert.ok(
      Math.abs(card.y - frame.y - added.position.y) < 1,
      'final drag coordinates cannot overwrite group-relative placement',
    );
    await screenshot('joined');
    console.log(
      'PASS circle becomes confirmation; only release joins, with split-compatible jitter tolerance and correct final placement',
    );

    // The finished drag must not suppress a later gesture, including the existing split hold.
    const addedRect = await rect(`${node('outside')} .material-handle`);
    p = { x: addedRect.x + 20, y: addedRect.y + 20 };
    send('mouseDown', p);
    await sleep(800);
    assert.equal(await parent(), 'target', 'split still waits for release');
    assert.equal(
      await run(
        'document.querySelector(".hold-feedback [role=status]").textContent',
      ),
      '松开拆分，移动取消',
    );
    send('mouseUp', p);
    await sleep(250);
    assert.equal(await parent(), undefined);
    console.log(
      'PASS the shared split circle still completes and detaches only on release',
    );

    await load();
    p = await grab();
    await sleep(170);
    send('mouseUp', p);
    await sleep(800);
    assert.equal(await parent(), undefined, 'early release cancels');
    assert.equal(
      await run('!!document.querySelector(".hold-feedback[data-open=true]")'),
      false,
    );
    console.log('PASS release before completion does not join later');

    await load();
    p = await grab();
    await sleep(200);
    const outside = { x: 390, y: 650 };
    await move(p, outside);
    await sleep(750);
    assert.equal(await parent(), undefined);
    assert.equal(
      await run('!!document.querySelector("[data-receiving=true]")'),
      false,
    );
    await move(outside, p);
    await sleep(160);
    assert.equal(await parent(), undefined, 'return starts a fresh dwell');
    await sleep(600);
    assert.equal(await parent(), undefined);
    send('mouseUp', p);
    await sleep(100);
    assert.equal(await parent(), 'target');
    console.log(
      'PASS leaving cancels feedback; returning restarts the whole dwell',
    );

    await load();
    p = await grab();
    await sleep(220);
    const second = await destination('second');
    await move(p, second);
    await sleep(160);
    assert.equal(await parent(), undefined);
    await sleep(650);
    assert.equal(await parent(), undefined);
    send('mouseUp', second);
    await sleep(100);
    assert.equal(await parent(), 'second');
    assert.equal(
      (await state()).nodes.filter((n) => n.groupId === 'target').length,
      1,
    );
    console.log(
      'PASS changing target resets progress and joins only the new group',
    );

    await load('?zoom');
    p = await grab();
    await sleep(800);
    assert.equal(await parent(), undefined);
    send('mouseUp', p);
    await sleep(100);
    assert.equal(await parent(), 'target', 'hit testing respects zoom and pan');
    console.log('PASS hovered group detection respects viewport zoom and pan');

    // Movement AFTER the checkmark cancels even while remaining inside the same target.
    await load();
    p = await grab();
    await sleep(800);
    const shifted = { x: p.x + 24, y: p.y };
    await move(p, shifted);
    await sleep(800);
    assert.equal(
      await run('!!document.querySelector(".hold-feedback[data-open=true]")'),
      false,
      'cancelled confirmation must not rearm in the same drag',
    );
    send('mouseUp', shifted);
    await sleep(100);
    assert.equal(await parent(), undefined);
    console.log(
      'PASS dragging after confirmation cancels joining, even inside the same group',
    );

    // Moving throughout the countdown is not a stationary hold.
    await load();
    p = await grab();
    for (let i = 0; i < 20; i++) {
      send('mouseMove', { x: p.x + (i % 2 ? 24 : 0), y: p.y });
      await sleep(50);
    }
    send('mouseUp', { x: p.x + 24, y: p.y });
    await sleep(100);
    assert.equal(await parent(), undefined);
    console.log('PASS continuous movement cannot finish the hold countdown');

    for (const reason of [
      'Escape',
      'blur',
      'pointercancel',
      'blocked',
      'close',
    ]) {
      await load();
      p = await grab();
      await sleep(800);
      assert.equal(await parent(), undefined);
      if (reason === 'Escape') {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      } else if (reason === 'blocked' || reason === 'close') {
        await run(
          `document.querySelector('#${reason === 'blocked' ? 'block' : 'close'}').click()`,
        );
      } else await run(`window.dispatchEvent(new Event('${reason}'))`);
      await sleep(800);
      assert.equal(await parent(), undefined, `${reason} cancels pending join`);
      send('mouseUp', p);
      await sleep(100);
      assert.equal(
        await parent(),
        undefined,
        `${reason} cannot merge on release`,
      );
    }
    console.log(
      'PASS Escape, blur, pointer cancellation, edit blocking and unmount cancel pending work',
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    failed = true;
    console.error(error);
    console.error('renderer errors', errors);
    await screenshot('failure');
  } finally {
    clearInterval(timer);
    win.destroy();
    rmSync(scratch, { recursive: true, force: true });
    app.exit(failed ? 1 : 0);
  }
});
