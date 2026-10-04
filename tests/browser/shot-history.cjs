// Isolated Electron renderer regression; reuse a Vite server, never open the user's library.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow, protocol } = require('electron');
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'afflatus-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const root = resolve(__dirname, '../..');
const scratch = mkdtempSync(join(root, 'src/renderer/.shot-history-test-'));
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/shot-history.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.once('will-quit', () => rmSync(scratch, { recursive: true, force: true }));
app.whenReady().then(async () => {
  protocol.handle(
    'afflatus-media',
    () =>
      new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#bdd7f0"/></svg>',
        { headers: { 'Content-Type': 'image/svg+xml' } },
      ),
  );
  const win = new BrowserWindow({
    width: 1400,
    height: 950,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  const wc = win.webContents;
  const run = (source) => wc.executeJavaScript(source);
  const errors = [];
  wc.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const state = () =>
    run('JSON.parse(document.querySelector("#state").textContent)');
  const shot = async () =>
    (await state()).shots.find((item) => item.id === 'one');
  const page = 'section[aria-label$="素材子画布"]';
  const undo = `${page} > header button[aria-label="撤销"]`;
  const redo = `${page} > header button[aria-label="重做"]`;
  const click = async (selector) => {
    await run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await sleep(60);
  };
  const waitFor = async (expression) => {
    for (let i = 0; i < 60; i++) {
      if (await run(expression)) return;
      await sleep(30);
    }
    throw new Error(`Timed out: ${expression}`);
  };
  const focusPage = () =>
    run(`document.querySelector(${JSON.stringify(page)}).focus()`);
  const point = (selector) =>
    run(`(() => {
      const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
  const drag = async (selector, dx, dy) => {
    const from = await point(selector);
    wc.sendInputEvent({ type: 'mouseMove', ...from });
    wc.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...from,
    });
    for (let i = 1; i <= 12; i++) {
      wc.sendInputEvent({
        type: 'mouseMove',
        modifiers: ['leftButtonDown'],
        x: Math.round(from.x + (dx * i) / 12),
        y: Math.round(from.y + (dy * i) / 12),
      });
      await sleep(18);
    }
    wc.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      x: from.x + dx,
      y: from.y + dy,
    });
    await sleep(150);
  };
  const hotkey = async (
    modifiers = [process.platform === 'darwin' ? 'meta' : 'control'],
    keyCode = 'z',
  ) => {
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(80);
  };
  const load = async () => {
    await win.loadURL(`http://127.0.0.1:5173/${basename(scratch)}/index.html`);
    await waitFor(`!!document.querySelector(${JSON.stringify(undo)})`);
    await sleep(150);
  };
  let failed = false;
  try {
    await load();
    await click('[data-id="text-one"] button[aria-label="移除文本卡片"]');
    assert.equal(
      (await shot()).nodes.some((node) => node.id === 'text-one'),
      false,
    );
    await focusPage();
    await hotkey();
    assert.equal(
      (await shot()).nodes.find((node) => node.id === 'text-one').text,
      '第一段自写文本',
    );
    await click(redo);
    assert.equal(
      (await shot()).nodes.some((node) => node.id === 'text-one'),
      false,
    );
    await click(undo);
    await click('#open-two');
    assert.equal(
      await run(`document.querySelector(${JSON.stringify(undo)}).disabled`),
      true,
    );
    await click('#open-one');
    assert.equal(
      await run(`document.querySelector(${JSON.stringify(redo)}).disabled`),
      false,
    );
    await click(redo);
    await click('#flush');
    await waitFor(
      'JSON.parse(document.querySelector("#state").textContent).flushed === true',
    );
    assert.equal(
      (await state()).stored.shots[0].nodes.some(
        (node) => node.id === 'text-one',
      ),
      false,
    );
    console.log(
      'PASS delete/undo/redo, per-shot session isolation and persistence through autosave/flush',
    );

    await load();
    await click('[data-id="text-one"] button[aria-label="移除文本卡片"]');
    await run('document.querySelector("textarea").focus()');
    await hotkey();
    assert.equal(
      (await shot()).nodes.some((node) => node.id === 'text-one'),
      false,
    );
    await focusPage();
    await run(
      `document.querySelector(${JSON.stringify(page)}).dispatchEvent(new KeyboardEvent('keydown', { key:'z', metaKey:${process.platform === 'darwin'}, ctrlKey:${process.platform !== 'darwin'}, isComposing:true, bubbles:true, cancelable:true }))`,
    );
    assert.equal(
      (await shot()).nodes.some((node) => node.id === 'text-one'),
      false,
    );
    await run(
      `document.querySelector(${JSON.stringify(page)}).dispatchEvent(new PointerEvent('pointerdown', { pointerId: 71, button:0, bubbles:true }))`,
    );
    await hotkey();
    assert.equal(
      (await shot()).nodes.some((node) => node.id === 'text-one'),
      false,
    );
    await run(
      'window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 71, button:0 }))',
    );
    await hotkey();
    assert.equal(
      (await shot()).nodes.some((node) => node.id === 'text-one'),
      true,
    );
    console.log(
      'PASS shortcuts respect text inputs, IME and held pointer gestures',
    );

    await load();
    await click('#space-shortcut');
    await run(
      `document.querySelector(${JSON.stringify(page)}).querySelector('button[aria-label="撤销"]').focus()`,
    );
    // Focus the actual add-text button; Space must retain native activation, even when bound to undo.
    await run(
      `([...document.querySelectorAll(${JSON.stringify(`${page} button`)})].find(button => button.textContent.trim() === '文本')).focus()`,
    );
    await hotkey([], 'Space');
    assert.equal((await shot()).nodes.length, 4);
    await focusPage();
    await hotkey([], 'Space');
    assert.equal((await shot()).nodes.length, 3);
    console.log(
      'PASS custom Space shortcut keeps native focused-button activation',
    );

    await load();
    const originalColor = (await shot()).labels[0].color;
    await click('[data-id="text-one"] button[aria-label="移除文本卡片"]');
    await run(`(async () => {
      const input = document.querySelector('input[aria-label="标签颜色"]');
      input.focus();
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (let i = 1; i <= 60; i++) {
        set.call(input, '#' + (0x110000 + i).toString(16));
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    })()`);
    assert.equal((await shot()).labels[0].color, '#11003c');
    await focusPage();
    await click(undo);
    assert.equal((await shot()).labels[0].color, originalColor);
    await click(undo);
    assert.equal((await shot()).nodes.length, 3);
    console.log(
      'PASS continuous color changes use one step and retain previous history',
    );

    await load();
    const originalText = (await shot()).nodes[0].text;
    await run(`(async () => {
      const input = document.querySelector('[data-id="text-one"] textarea');
      input.focus();
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      for (const value of ['新', '新的', '新的完整文本']) {
        set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    })()`);
    assert.equal((await shot()).nodes[0].text, '新的完整文本');
    await focusPage();
    await click(undo);
    assert.equal((await shot()).nodes[0].text, originalText);
    assert.equal((await state()).firstHistory.canUndo, false);
    await click(redo);
    const beforeDrag = (await shot()).nodes[0].position;
    await drag('[data-id="text-one"] .material-handle > svg', 70, 80);
    const afterDrag = (await shot()).nodes[0].position;
    assert.notDeepEqual(afterDrag, beforeDrag);
    await drag('[data-id="text-one"] .material-resize', 80, 70);
    const resized = (await shot()).nodes[0];
    assert.ok(resized.width > 260);
    await click(undo);
    assert.equal((await shot()).nodes[0].width, undefined);
    assert.deepEqual((await shot()).nodes[0].position, afterDrag);
    await click(undo);
    assert.deepEqual((await shot()).nodes[0].position, beforeDrag);
    assert.equal((await shot()).nodes[0].text, '新的完整文本');
    await click('#view-change');
    await click(undo);
    assert.equal((await shot()).nodes[0].text, originalText);
    assert.deepEqual((await shot()).position, { x: 700, y: 800 });
    assert.deepEqual((await shot()).viewport, { x: 12, y: 34, zoom: 1.2 });
    console.log(
      'PASS text merges and pointer drag/resize each undo once without rolling back camera or main position',
    );

    await load();
    await click('#group');
    await click('[data-id="group"] button[aria-expanded]');
    await waitFor('!!document.querySelector("dialog[open]")');
    const grouped = await shot();
    await run('document.querySelector("dialog[open] button").focus()');
    await hotkey();
    assert.deepEqual((await shot()).groups, grouped.groups);
    await click('dialog[open] button[aria-label="撤销"]');
    await waitFor('!document.querySelector("dialog[open]")');
    assert.equal((await shot()).groups.length, 0);
    assert.equal((await shot()).nodes.length, 3);
    console.log(
      'PASS open group does not pass keyboard shortcuts through; explicit undo closes removed group',
    );

    await load();
    await click('#group');
    await click('[data-id="group"] button[aria-expanded]');
    const originalParameters = (await shot()).groups[0].parameters;
    await run(`(async () => {
      const select = document.querySelector('#generation-duration');
      for (const value of ['6', '7']) {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      [...document.querySelectorAll('fieldset[aria-label="分辨率"] button')].find(button => button.textContent === '480p').click();
    })()`);
    assert.equal((await shot()).groups[0].parameters.duration, 7);
    assert.equal((await shot()).groups[0].parameters.resolution, '480p');
    await click('dialog[open] button[aria-label="撤销"]');
    assert.equal((await shot()).groups[0].parameters.duration, 7);
    assert.equal(
      (await shot()).groups[0].parameters.resolution,
      originalParameters.resolution,
    );
    await click('dialog[open] button[aria-label="撤销"]');
    assert.deepEqual((await shot()).groups[0].parameters, originalParameters);
    await click('button[aria-label="下移文本块 1"]');
    assert.deepEqual(
      (await shot()).nodes
        .filter((node) => node.groupId === 'group')
        .map((node) => node.id),
      ['text-two', 'text-one'],
    );
    await click('dialog[open] button[aria-label="撤销"]');
    assert.deepEqual(
      (await shot()).nodes
        .filter((node) => node.groupId === 'group')
        .map((node) => node.id),
      ['text-one', 'text-two'],
    );
    await click('button[aria-label="移出文本块 1"]');
    assert.equal(
      (await shot()).nodes.find((node) => node.id === 'text-one').groupId,
      undefined,
    );
    await click('dialog[open] button[aria-label="撤销"]');
    assert.equal(
      (await shot()).nodes.find((node) => node.id === 'text-one').groupId,
      'group',
    );
    console.log(
      'PASS parameter controls retain separate steps; group text ordering and detach restore',
    );

    await load();
    await click('#image-group');
    await click('[data-id="image-group"] button[aria-expanded]');
    await waitFor(
      'document.querySelectorAll("[data-text-block]").length === 1',
    );
    const placeholder = (await shot()).nodes.find(
      (node) => node.groupId === 'image-group' && node.type === 'text',
    );
    assert.ok(placeholder);
    await click('dialog[open] button[aria-label="撤销"]');
    await waitFor('!document.querySelector("dialog[open]")');
    assert.equal((await shot()).groups.length, 0);
    assert.equal(
      (await shot()).nodes.some((node) => node.id === placeholder.id),
      false,
    );
    await click(redo);
    await click('[data-id="image-group"] button[aria-expanded]');
    await waitFor(
      'document.querySelectorAll("[data-text-block]").length === 1',
    );
    assert.equal(
      (await shot()).nodes.filter(
        (node) => node.groupId === 'image-group' && node.type === 'text',
      ).length,
      1,
    );
    console.log(
      'PASS automatic empty text is not an undo step and redo/reopen does not duplicate it',
    );

    await load();
    await click('[data-id="text-one"] button[aria-label="移除文本卡片"]');
    await click('#fail');
    await click(undo);
    await click('#flush');
    await waitFor(
      'JSON.parse(document.querySelector("#state").textContent).flushed === false',
    );
    assert.equal(
      (await shot()).nodes.find((node) => node.id === 'text-one').text,
      '第一段自写文本',
    );
    await click('#recover');
    await click('#flush');
    await waitFor(
      'JSON.parse(document.querySelector("#state").textContent).flushed === true',
    );
    assert.equal(
      (await state()).stored.shots[0].nodes.some(
        (node) => node.id === 'text-one',
      ),
      true,
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS failed save preserves restored draft and retry commits it',
    );
  } catch (error) {
    failed = true;
    console.error(error);
    console.error(errors);
  } finally {
    win.destroy();
    rmSync(scratch, { recursive: true, force: true });
    app.exit(failed ? 1 : 0);
  }
});
