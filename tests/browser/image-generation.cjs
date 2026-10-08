// Isolated Electron UI regression. Reuse Vite; all drafts and media stay synthetic.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = require('node:fs');
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
const scratch = mkdtempSync(join(root, 'src/renderer/.image-generation-test-'));
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/image-generation.fixture.tsx"></script></body></html>`,
);
app.once('will-quit', () => rmSync(scratch, { recursive: true, force: true }));

function silentWav() {
  const samples = 8000;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

app.whenReady().then(async () => {
  let assetKind = 'image';
  protocol.handle('afflatus-media', () =>
    assetKind === 'image'
      ? new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#e2edfa"/><circle cx="150" cy="100" r="60" fill="#2563eb"/></svg>',
          { headers: { 'Content-Type': 'image/svg+xml' } },
        )
      : new Response(silentWav(), {
          headers: { 'Content-Type': 'audio/wav' },
        }),
  );
  const win = new BrowserWindow({
    width: 1400,
    height: 940,
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
      // Hidden macOS surfaces can be unavailable before their first frame.
    } finally {
      painting = false;
    }
  }, 32);
  const state = () =>
    run('JSON.parse(document.querySelector("#state").textContent)');
  const node = (id) => `.react-flow__node[data-id="${id}"]`;
  const imageDialog = 'dialog[aria-label="图片生成组合编辑"]';
  const videoDialog = 'dialog[aria-label="视频生成组合编辑"]';
  const find = (selector, text) =>
    `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
  const point = (expression, corner = false) =>
    run(`(() => {
      const element = ${expression};
      if (!element) throw new Error('Missing test target: ' + ${JSON.stringify(expression)});
      const r = element.getBoundingClientRect();
      return {x: Math.round(r.x + ${corner ? '9' : 'r.width / 2'}), y: Math.round(r.y + ${corner ? '17' : 'r.height / 2'})};
    })()`);
  const clickAt = async (p, button = 'left', modifiers = []) => {
    wc.sendInputEvent({ type: 'mouseMove', ...p });
    wc.sendInputEvent({
      type: 'mouseDown',
      ...p,
      button,
      clickCount: 1,
      modifiers,
    });
    wc.sendInputEvent({
      type: 'mouseUp',
      ...p,
      button,
      clickCount: 1,
      modifiers,
    });
    await sleep(120);
  };
  const clickText = async (text, selector = 'button') =>
    clickAt(await point(find(selector, text)));
  const selectCard = async (id) =>
    clickAt(
      await point(
        `document.querySelector(${JSON.stringify(`${node(id)} .material-handle`)})`,
        true,
      ),
    );
  const selectCards = async (ids) => {
    if (ids.length === 1) return selectCard(ids[0]);
    const bounds = await run(`(() => {
      const rects = ${JSON.stringify(ids)}.map(id => document.querySelector('.react-flow__node[data-id="' + id + '"]').getBoundingClientRect());
      return {x: Math.floor(Math.min(...rects.map(r => r.left)) - 12), y: Math.floor(Math.min(...rects.map(r => r.top)) - 12), right: Math.ceil(Math.max(...rects.map(r => r.right)) + 12), bottom: Math.ceil(Math.max(...rects.map(r => r.bottom)) + 12)};
    })()`);
    wc.sendInputEvent({
      type: 'mouseDown',
      button: 'right',
      clickCount: 1,
      x: bounds.x,
      y: bounds.y,
    });
    for (let i = 1; i <= 10; i++) {
      wc.sendInputEvent({
        type: 'mouseMove',
        modifiers: ['rightButtonDown'],
        x: Math.round(bounds.x + ((bounds.right - bounds.x) * i) / 10),
        y: Math.round(bounds.y + ((bounds.bottom - bounds.y) * i) / 10),
      });
      await sleep(20);
    }
    wc.sendInputEvent({
      type: 'mouseUp',
      button: 'right',
      clickCount: 1,
      x: bounds.right,
      y: bounds.bottom,
    });
    await sleep(120);
    assert.equal(
      await run(
        'document.querySelectorAll(".react-flow__node.selected").length',
      ),
      ids.length,
      'right-button rectangle must select every input',
    );
  };
  const menu = async (id) =>
    clickAt(
      await point(
        `document.querySelector(${JSON.stringify(`${node(id)} .material-handle`)})`,
        true,
      ),
      'right',
    );
  const selectOption = async (selector, value) => {
    const index = await run(
      `Array.from(document.querySelector(${JSON.stringify(selector)}).options).findIndex(o => o.value === ${JSON.stringify(value)})`,
    );
    assert.ok(index >= 0, `option ${value} must exist`);
    // A hidden macOS window cannot interact with the native select popup. Change
    // the real HTML select and dispatch its standard event; grouping still uses
    // native mouse input, and parameter updates travel through the production UI.
    await run(`(() => {
      const select = document.querySelector(${JSON.stringify(selector)});
      select.selectedIndex = ${index};
      select.dispatchEvent(new Event('change', {bubbles: true}));
    })()`);
    await sleep(150);
    assert.equal(
      await run(`document.querySelector(${JSON.stringify(selector)}).value`),
      value,
    );
  };
  const exists = (selector) =>
    run(`!!document.querySelector(${JSON.stringify(selector)})`);
  const disabled = (selector, text) =>
    run(
      `(() => { const el = ${find(selector, text)}; return !!el && (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled')); })()`,
    );
  const load = async (kind = 'image') => {
    assetKind = kind;
    await win.loadURL(
      `http://127.0.0.1:5173/${basename(scratch)}/index.html?asset=${kind}`,
    );
    for (let i = 0; i < 50; i++) {
      if (await exists(node('text'))) break;
      await sleep(100);
    }
    assert.equal(await exists(node('text')), true, 'fixture must load');
    await sleep(350);
  };
  const openGroup = async (id) => {
    await clickText('展开编辑', `${node(id)} button`);
    await sleep(500);
  };
  const closeGroup = async () => {
    await clickText('收起组合', 'dialog button');
    await sleep(350);
  };
  const groupFrom = async (ids, action = '生成图片', useMenu = false) => {
    await selectCards(ids);
    if (useMenu) {
      await menu(ids[0]);
      await clickText(action, '[role="menuitem"]');
    } else {
      const p = await point(
        `Array.from(document.querySelectorAll('.react-flow__panel button')).find(el => el.textContent.trim().startsWith(${JSON.stringify(action)}))`,
      );
      await clickAt(p);
    }
    await sleep(180);
    const shot = await state();
    assert.equal(shot.groups.length, 1);
    return shot.groups[0];
  };
  const screenshot = async (name) => {
    const dir = process.env.AFFLATUS_TEST_SCREENSHOTS;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.png`), (await wc.capturePage()).toPNG());
  };

  let failed = false;
  try {
    await load();
    let group = await groupFrom(['text']);
    assert.equal(group.kind, 'image');
    assert.equal(
      await exists(imageDialog),
      false,
      'grouping must stay on canvas',
    );
    assert.equal(
      await run(
        `document.querySelector(${JSON.stringify(node(group.id))}).textContent.includes('图片生成')`,
      ),
      true,
    );
    await openGroup(group.id);
    assert.equal(await exists(imageDialog), true);
    let content = await run(
      `document.querySelector('${imageDialog}').textContent`,
    );
    assert.equal(
      await exists(`${imageDialog} aside[aria-label="图片生成设置"]`),
      true,
    );
    assert.ok(content.includes('文生图'));
    assert.equal(content.includes('视频时长'), false);
    assert.equal(content.includes('生成声音'), false);
    assert.equal(await exists('#generation-model'), false);
    assert.equal(await disabled(`${imageDialog} button`, '生成图片'), false);
    assert.ok(content.includes('任务与候选'));
    assert.ok(!content.includes('生成成功'));
    assert.deepEqual(group.parameters, {
      model: 'seedream-5.0-lite',
      ratio: '1:1',
      resolution: '2K',
    });
    await clickText('3K', `${imageDialog} button`);
    assert.equal((await state()).groups[0].parameters.resolution, '3K');
    await selectOption('#image-generation-model', 'seedream-4.5');
    assert.equal(await disabled(`${imageDialog} button`, '3K'), true);
    assert.notEqual((await state()).groups[0].parameters.resolution, '3K');
    await clickText('4K', `${imageDialog} button`);
    await selectOption('#image-generation-ratio', '16:9');
    const configured = (await state()).groups[0].parameters;
    await screenshot('text-to-image');
    await closeGroup();
    assert.equal(await exists(imageDialog), false);
    await openGroup(group.id);
    assert.deepEqual((await state()).groups[0].parameters, configured);
    assert.equal(
      await run('document.querySelector("#image-generation-model").value'),
      'seedream-4.5',
    );
    assert.equal(
      await run('document.querySelector("#image-generation-ratio").value'),
      '16:9',
    );
    console.log(
      'PASS text-to-image groups stay on canvas; Seedream controls persist on reopen and enforce model resolution support',
    );

    await load();
    group = await groupFrom(['text', 'reference'], '生成图片', true);
    assert.equal(group.kind, 'image');
    assert.equal(
      (await state()).nodes.filter((n) => n.groupId === group.id).length,
      2,
    );
    assert.equal(await exists(imageDialog), false);
    await openGroup(group.id);
    content = await run(`document.querySelector('${imageDialog}').textContent`);
    assert.ok(content.includes('图生图'));
    assert.equal(
      await run(`document.querySelector('${imageDialog} textarea').value`),
      '蓝色圆球放在浅色桌面上，柔和的自然光。',
    );
    assert.equal(
      await run(
        `document.querySelector('${imageDialog} img').naturalWidth > 0`,
      ),
      true,
    );
    await screenshot('image-to-image');
    console.log(
      'PASS text plus image can create image-to-image from the context menu with original prompt and synthetic media',
    );

    await load();
    group = await groupFrom(['reference']);
    assert.equal(
      (await state()).nodes.filter((n) => n.groupId === group.id).length,
      1,
    );
    await openGroup(group.id);
    let textMembers = (await state()).nodes.filter(
      (n) => n.groupId === group.id && n.type === 'text',
    );
    assert.equal(textMembers.length, 1);
    assert.equal(textMembers[0].text, '');
    const placeholder = textMembers[0].id;
    await closeGroup();
    await openGroup(group.id);
    textMembers = (await state()).nodes.filter(
      (n) => n.groupId === group.id && n.type === 'text',
    );
    assert.equal(textMembers.length, 1);
    assert.equal(textMembers[0].id, placeholder);
    console.log(
      'PASS image-only editing adds one blank prompt and reopening never duplicates it',
    );

    for (const kind of ['video', 'audio']) {
      await load(kind);
      await selectCards(['text', 'reference']);
      await menu('text');
      assert.equal(
        await disabled('[role="menuitem"]', '生成图片'),
        true,
        `${kind} cannot join image generation`,
      );
      assert.equal(await disabled('[role="menuitem"]', '生成视频'), false);
      await clickText('生成视频', '[role="menuitem"]');
      await sleep(180);
      group = (await state()).groups[0];
      assert.ok(group, 'video generation should still group the selection');
      assert.notEqual(group.kind, 'image');
      assert.equal(await exists(videoDialog), false);
      await openGroup(group.id);
      assert.equal(await exists(videoDialog), true);
      assert.equal(
        await run('document.querySelector("#generation-model").value'),
        'seedance-2.0',
      );
      content = await run(
        `document.querySelector('${videoDialog}').textContent`,
      );
      assert.ok(content.includes('视频时长'));
      assert.ok(content.includes('生成声音'));
      assert.equal(await exists('#image-generation-model'), false);
    }
    console.log(
      'PASS video and audio cannot generate images; their original Seedance group editor remains functional',
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
