// Isolated renderer regression checks against an existing Vite server; no project files/IPC.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require('node:fs');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = resolve(__dirname, '../..');
const scratch = mkdtempSync(join(root, 'src/renderer/.surface-test-'));
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/surface-motion.fixture.tsx"></script></body></html>`,
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
  let painting = false;
  const paint = setInterval(async () => {
    if (painting || wc.isDestroyed()) return;
    painting = true;
    try {
      await wc.capturePage();
    } catch {
      // A navigation can temporarily dispose the hidden compositor surface.
    } finally {
      painting = false;
    }
  }, 32);
  const errors = [];
  wc.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const counts = () =>
    run(`JSON.parse(document.querySelector('#counts').textContent)`);
  const exists = (selector) =>
    run(`!!document.querySelector(${JSON.stringify(selector)})`);
  const page = 'section[aria-label="测试镜头素材子画布"]';
  const click = async (selector) => {
    const p = await run(
      `(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}})()`,
    );
    wc.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...p,
    });
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p });
    await sleep(25);
  };
  const resolveSave = (success) =>
    run(`document.querySelector('#save-${success ? 'ok' : 'fail'}').click()`);
  const waitFor = async (check, message) => {
    for (let i = 0; i < 60; i++) {
      if (await check()) return;
      await sleep(25);
    }
    assert.fail(message);
  };
  const openPage = async () => {
    await click('#open-page');
    await waitFor(() => exists(page), 'page opens');
  };
  const back = `${page} header button`;
  let failed = false;
  try {
    await win.loadURL(`http://127.0.0.1:5173/${basename(scratch)}/index.html`);
    await waitFor(() => exists('#open-page'), 'fixture loads');
    await openPage();
    assert.equal(await run('document.querySelector("#root").inert'), true);
    await click(back);
    await click(back);
    assert.equal(
      (await counts()).saves,
      1,
      'duplicate return does not start another save',
    );
    assert.equal(await run(`document.querySelector('${page}').inert`), true);
    await resolveSave(false);
    await sleep(300);
    assert.equal(
      await exists(page),
      true,
      'save failure keeps page mounted and visible',
    );
    assert.equal(await run(`document.querySelector('${page}').inert`), false);
    assert.equal((await counts()).closed, 0);
    await click(back);
    await resolveSave(true);
    await waitFor(async () => !(await exists(page)), 'saved page closes');
    assert.equal((await counts()).closed, 1);
    assert.equal(await run('document.querySelector("#root").inert'), false);
    assert.equal(await run('document.activeElement.id'), 'open-page');
    console.log(
      'PASS save failure restores editing; save success closes once and restores canvas focus',
    );

    await openPage();
    // Freeze an intermediate entry pose, then close while entry is unfinished.
    await run(
      `document.querySelector('${page}').getAnimations().forEach(a => {a.pause();a.currentTime=40})`,
    );
    const entryOpacity = await run(
      `getComputedStyle(document.querySelector('${page}')).opacity`,
    );
    await click(back);
    await resolveSave(true);
    const start = await run(
      `document.querySelector('${page}').getAnimations()[0]?.effect.getKeyframes()[0].opacity`,
    );
    assert.equal(
      Number(start),
      Number(entryOpacity),
      'exit uses current pose rather than flashing fully opaque',
    );
    await waitFor(
      async () => !(await exists(page)),
      'interrupted entry closes',
    );
    const previous = (await counts()).closed;
    await openPage();
    await click(back);
    await run(`document.querySelector('#unmount-page').click()`);
    await resolveSave(true);
    await sleep(200);
    assert.equal(
      (await counts()).closed,
      previous,
      'late save completion cannot dismiss another surface',
    );
    console.log(
      'PASS entry interruption and unmount during save avoid stale close callbacks',
    );

    await click('#open-modal');
    await sleep(300);
    await click('#footer-close');
    assert.equal(
      await exists('dialog.is-closing'),
      true,
      'footer uses exit motion',
    );
    assert.equal(await run('document.querySelector("dialog").inert'), true);
    await waitFor(
      async () => !(await exists('dialog')),
      'footer closes dialog',
    );
    await click('#open-modal');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(30);
    assert.equal(await exists('dialog'), false, 'keyboard close is immediate');
    console.log(
      'PASS footer and keyboard modal close share lifecycle without delaying keyboard input',
    );

    await click('#open-settings');
    await sleep(300);
    const checkbox = 'input[type="checkbox"]';
    const original = await run(`document.querySelector('${checkbox}').checked`);
    await click(checkbox);
    await click('.t-segmented button:nth-of-type(2)');
    await sleep(300);
    await click('.t-segmented button:nth-of-type(1)');
    await sleep(300);
    assert.equal(
      await run(`document.querySelector('${checkbox}').checked`),
      !original,
      'tab animation preserves unsaved form state',
    );
    if (process.env.AFFLATUS_TEST_SCREENSHOTS) {
      mkdirSync(process.env.AFFLATUS_TEST_SCREENSHOTS, { recursive: true });
      writeFileSync(
        join(process.env.AFFLATUS_TEST_SCREENSHOTS, 'settings.png'),
        (await wc.capturePage()).toPNG(),
      );
    }
    await click('button[aria-label="关闭"]');
    await sleep(200);
    console.log('PASS settings tab transitions preserve unsaved inputs');

    const target = await run(
      `(() => {const r=document.querySelector('#menu-target').getBoundingClientRect();return {x:Math.round(r.x+20),y:Math.round(r.y+20)}})()`,
    );
    wc.sendInputEvent({
      type: 'mouseDown',
      button: 'right',
      clickCount: 1,
      ...target,
    });
    wc.sendInputEvent({
      type: 'mouseUp',
      button: 'right',
      clickCount: 1,
      ...target,
    });
    await waitFor(() => exists('.t-context-menu'), 'context menu opens');
    await sleep(300);
    assert.equal(
      await run(
        `getComputedStyle(document.querySelector('.t-context-menu')).opacity`,
      ),
      '1',
    );
    await click('#menu-action');
    await waitFor(
      async () => !(await exists('.t-context-menu')),
      'menu unmounts after fade',
    );
    wc.sendInputEvent({
      type: 'mouseDown',
      button: 'right',
      clickCount: 1,
      ...target,
    });
    wc.sendInputEvent({
      type: 'mouseUp',
      button: 'right',
      clickCount: 1,
      ...target,
    });
    await waitFor(() => exists('.t-context-menu'), 'reopen context menu');
    await sleep(300);
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(35);
    assert.equal(
      await exists('.t-context-menu'),
      false,
      'keyboard menu dismissal is instant',
    );
    console.log('PASS Base UI context menu enters and unmounts cleanly');

    wc.debugger.attach();
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await openPage();
    assert.equal(
      await run(`document.querySelector('${page}').getAnimations().length`),
      0,
    );
    await click(back);
    await resolveSave(true);
    await sleep(25);
    assert.equal(
      await exists(page),
      false,
      'reduced motion exits without waiting',
    );
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS reduced motion stays instant; no renderer errors');
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    clearInterval(paint);
    win.destroy();
    app.exit(failed ? 1 : 0);
  }
});
