// Real Electron pointer/keyboard regressions in an isolated renderer using the existing Vite server.
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = resolve(__dirname, '../..');
const scratch = mkdtempSync(join(root, 'src/renderer/.material-test-'));
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/material-tools.fixture.tsx"></script></body></html>`,
);
app.once('will-quit', () => rmSync(scratch, { recursive: true, force: true }));
app.whenReady().then(async () => {
  protocol.handle(
    'afflatus-media',
    () =>
      new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#bdd7f0"/><circle cx="150" cy="100" r="65" fill="#2563eb"/></svg>',
        { headers: { 'Content-Type': 'image/svg+xml' } },
      ),
  );
  const win = new BrowserWindow({
    width: 1300,
    height: 900,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  const wc = win.webContents,
    run = (code) => wc.executeJavaScript(code);
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
      // Hidden macOS surfaces may not exist until the first compositor frame.
    } finally {
      painting = false;
    }
  }, 32);
  const state = () =>
    run('JSON.parse(document.querySelector("#state").textContent)');
  const rect = (selector) =>
    run(
      `(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`,
    );
  const point = async (selector) => {
    const r = await rect(selector);
    return {
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
    };
  };
  const down = (p) =>
    wc.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...p,
    });
  const up = (p) =>
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p });
  const click = async (selector) => {
    const p = await point(selector);
    down(p);
    up(p);
    await sleep(80);
  };
  const drag = async (from, to) => {
    down(from);
    for (let i = 1; i <= 12; i++) {
      wc.sendInputEvent({
        type: 'mouseMove',
        modifiers: ['leftButtonDown'],
        x: Math.round(from.x + ((to.x - from.x) * i) / 12),
        y: Math.round(from.y + ((to.y - from.y) * i) / 12),
      });
      await sleep(18);
    }
    up(to);
    await sleep(120);
  };
  const key = (type, keyCode) => wc.sendInputEvent({ type, keyCode });
  const rename = async (selector, name) => {
    await click(selector);
    await wc.insertText(name);
    key('keyDown', 'Return');
    key('keyUp', 'Return');
    await sleep(100);
  };
  const node = (id) => `.react-flow__node[data-id="${id}"]`;
  let failed = false;
  try {
    await win.loadURL(`http://127.0.0.1:5173/${basename(scratch)}/index.html`);
    await sleep(800);
    await rename(
      `${node('text')} button[aria-label="重命名卡片名称"]`,
      '开场独白',
    );
    await rename(
      `${node('asset')} button[aria-label="重命名卡片名称"]`,
      '人物参考',
    );
    assert.equal((await state()).nodes[0].name, '开场独白');
    assert.equal((await state()).nodes[1].name, '人物参考');
    assert.equal((await state()).nodes[1].assetId, 'image');
    await click(`${node('text')} header > svg`);
    let p = await point(`${node('text')} .material-resize`);
    await drag(p, { x: p.x + 140, y: p.y + 100 });
    assert.ok(
      (await state()).nodes[0].width >= 390,
      JSON.stringify(await state()),
    );
    assert.ok((await state()).nodes[0].height >= 335);
    p = await point(`${node('text')} .material-resize`);
    await drag(p, { x: p.x - 90, y: p.y - 60 });
    assert.ok((await state()).nodes[0].width < 390);
    const textRect = await rect(`${node('text')} textarea`);
    assert.ok(textRect.height > 230, 'textarea expands with card');
    await click(`${node('asset')} .material-handle > svg`);
    p = await point(`${node('asset')} .material-resize`);
    await drag(p, { x: p.x + 160, y: p.y + 90 });
    assert.ok((await state()).nodes[1].width >= 410);
    console.log(
      'PASS text/media rename independently; repeated resize tracks content and persists dimensions',
    );

    await run('document.querySelector("#group").click()');
    await sleep(150);
    await click(`${node('asset')} .material-handle > svg`);
    const parentBefore = (await state()).groups[0];
    const childBefore = (await state()).nodes[1];
    p = await point(`${node('asset')} .material-resize`);
    await drag(p, { x: p.x + 80, y: p.y + 10 });
    assert.deepEqual(
      (await state()).nodes[1].position,
      childBefore.position,
      'child stays anchored while its group expands',
    );
    assert.ok((await state()).groups[0].width > parentBefore.width);
    assert.ok(
      (await rect(node('group'))).width >= (await state()).groups[0].width - 1,
    );
    await run('document.querySelector("#ungroup").click()');
    await sleep(100);
    console.log(
      'PASS grouped resizing expands its parent and retains the child anchor',
    );

    await rename(
      `${node('local')} button[aria-label="重命名标签名称"]`,
      '人物设定',
    );
    await run(
      `(() => { const el=document.querySelector('${node('local')} input[type="color"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, '#22c55e'); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); })()`,
    );
    assert.equal((await state()).labels[1].color, '#22c55e');
    await click(`${node('local')} button[aria-label="固定标签"]`);
    const before = (await state()).labels[1].position;
    const r = await rect(node('local'));
    p = { x: Math.round(r.x + 90), y: Math.round(r.y + 26) };
    await drag(p, { x: p.x + 100, y: p.y + 80 });
    assert.deepEqual(
      (await state()).labels[1].position,
      before,
      'pinned label cannot move',
    );
    await click(`${node('local')} button[aria-label="取消固定标签"]`);
    p = await point(`${node('local')} .group\\/name`);
    await drag(p, { x: p.x + 60, y: p.y + 50 });
    assert.notDeepEqual((await state()).labels[1].position, before);
    console.log(
      'PASS labels rename/change color; pinned labels resist dragging and unlock normally',
    );

    // Blur any field. Key hold reveals north marker at the top edge, then zoom-out/pan/restore.
    await click(`${node('text')} header > svg`);
    key('keyDown', 'L');
    await sleep(60);
    assert.equal(
      await run('document.querySelector("[data-label-id=north]").dataset.edge'),
      'top',
    );
    const originalZoom = (await state()).viewport.zoom;
    await click('[data-label-id="north"]');
    await sleep(130);
    const zoomDuring = await run(
      'Number(document.querySelector(".react-flow__viewport").style.transform.match(/scale\\(([^)]+)\\)/)[1])',
    );
    assert.ok(zoomDuring < originalZoom, `zoom during flight ${zoomDuring}`);
    await sleep(850);
    assert.equal((await state()).viewport.zoom, originalZoom);
    const north = await rect(node('north'));
    assert.ok(Math.abs(north.x + north.width / 2 - 650) < 4);
    key('keyUp', 'L');
    await sleep(60);
    assert.equal(
      await run('!!document.querySelector(".label-locator")'),
      false,
    );
    console.log(
      'PASS held shortcut shows directional marker; camera zooms out, pans, restores zoom; release hides markers',
    );

    // Open a name field at the destination; typing the shortcut must only edit text.
    await click(`${node('north')} button[aria-label="重命名标签名称"]`);
    key('keyDown', 'L');
    key('keyUp', 'L');
    await sleep(40);
    assert.equal(
      await run('!!document.querySelector(".label-locator")'),
      false,
    );
    key('keyDown', 'Escape');
    key('keyUp', 'Escape');
    key('keyDown', 'L');
    await sleep(60);
    await click('[data-label-id="local"]');
    await sleep(120);
    down({ x: 25, y: 720 });
    up({ x: 25, y: 720 });
    await sleep(120);
    key('keyUp', 'L');
    const stopped = (await state()).viewport;
    await sleep(850);
    assert.deepEqual(
      (await state()).viewport,
      stopped,
      'pointer input interrupts camera flight',
    );
    console.log(
      'PASS text input ignores locator shortcut; pointer interrupts flight without jumping later',
    );

    wc.debugger.attach();
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    key('keyDown', 'L');
    await sleep(40);
    await click('[data-label-id="local"]');
    key('keyUp', 'L');
    const saved = await state();
    await click('section > header button');
    await sleep(300);
    await click('#reopen');
    await sleep(350);
    assert.deepEqual((await state()).nodes, saved.nodes);
    assert.deepEqual((await state()).labels, saved.labels);
    if (process.env.AFFLATUS_TEST_SCREENSHOT)
      writeFileSync(
        process.env.AFFLATUS_TEST_SCREENSHOT,
        (await wc.capturePage()).toPNG(),
      );
    assert.deepEqual(errors, []);
    console.log(
      'PASS reduced-motion navigation, remount persistence, no renderer errors',
    );
  } catch (error) {
    failed = true;
    console.error(error);
    console.error('Renderer errors:', errors);
  } finally {
    clearInterval(timer);
    win.destroy();
    rmSync(scratch, { recursive: true, force: true });
    app.exit(failed ? 1 : 0);
  }
});
