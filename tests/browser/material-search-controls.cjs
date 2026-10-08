// Actual canvas, picker and modal components; native keys/clicks with isolated storage/media.
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { basename, join, resolve } = require('node:path');
const { app, BrowserWindow, protocol } = require('electron');
const root = resolve(__dirname, '../..');
const origin = process.env.AFFLATUS_FIXTURE_ORIGIN;
const scratch = process.env.AFFLATUS_FIXTURE_SCRATCH;
const profile = process.env.AFFLATUS_FIXTURE_PROFILE;
if (!origin || !scratch || !profile)
  throw new Error('Use the isolated fixture runner');
app.setPath('userData', profile);
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'afflatus-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>素材查找验收</title><body><div id="root"></div><script>window.searchInputs=[];window.addEventListener('keydown',event=>searchInputs.push({key:event.key,trusted:event.isTrusted}),true)</script><script type="module" src="/@fs/${root}/tests/browser/material-search-controls.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  let mediaRequests = 0;
  protocol.handle('afflatus-media', () => {
    mediaRequests++;
    return new Response(
      '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#6ea3b4"/></svg>',
      { headers: { 'Content-Type': 'image/svg+xml' } },
    );
  });
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const wc = win.webContents;
  const run = (source) => wc.executeJavaScript(source);
  const errors = [];
  let exitCode = 0;
  wc.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const paint = () =>
    run(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
  const wait = async (source, label) => {
    for (let i = 0; i < 200; i++) {
      if (await run(source)) return;
      await sleep(25);
    }
    throw new Error(
      `Timed out: ${label}; focus=${await run('JSON.stringify({focused:document.hasFocus(),active:document.activeElement?.outerHTML?.slice(0,300)})')}`,
    );
  };
  const focus = async (selector) => {
    app.focus({ steal: true });
    win.focus();
    wc.focus();
    await wait('document.hasFocus()', 'native activation');
    await wait(
      `!!document.querySelector(${JSON.stringify(selector)})`,
      `target exists ${selector}`,
    );
    await run(
      `document.querySelector(${JSON.stringify(selector)}).focus({preventScroll:true})`,
    );
    await wait(
      `document.activeElement===document.querySelector(${JSON.stringify(selector)})`,
      `focus ${selector}`,
    );
  };
  const key = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await paint();
  };
  const click = async (selector) => {
    await focus(selector);
    await run(
      `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`,
    );
    const point = await run(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
    );
    wc.sendInputEvent({
      type: 'mouseDown',
      ...point,
      button: 'left',
      clickCount: 1,
    });
    wc.sendInputEvent({
      type: 'mouseUp',
      ...point,
      button: 'left',
      clickCount: 1,
    });
    await paint();
  };
  const button = async (label) => {
    const id = await run(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)});if(!b)throw Error('Missing button');b.dataset.testButton='target';return '[data-test-button="target"]'})()`,
    );
    await click(id);
    await run(
      'document.querySelector("[data-test-button=target]")?.removeAttribute("data-test-button")',
    );
  };
  const mod = process.platform === 'darwin' ? 'meta' : 'control';
  const input = async (selector, value) => {
    await focus(selector);
    await run(
      `(()=>{const target=document.querySelector(${JSON.stringify(selector)});target.setSelectionRange(0,target.value.length)})()`,
    );
    await wc.insertText(value);
    await paint();
    assert.equal(
      await run(`document.querySelector(${JSON.stringify(selector)}).value`),
      value,
      'Native input replaces the prepared query selection',
    );
  };
  const selectOption = async (selector, value) => {
    // Exercise the real select/change binding. Electron's injected Home/End
    // events do not control the macOS native option popup.
    await focus(selector);
    await run(
      `(()=>{const select=document.querySelector(${JSON.stringify(selector)});select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`,
    );
    await paint();
    assert.equal(
      await run(`document.querySelector(${JSON.stringify(selector)}).value`),
      value,
    );
  };
  const page = 'section[aria-label="素材查找素材子画布"]';
  const query = 'input[aria-label="搜索镜头素材"]';
  const state = () => run('materialSearch.state()');
  const open = async () => {
    await focus(page);
    await key('k', [mod]);
    await wait(
      `!!document.querySelector(${JSON.stringify(query)})`,
      'search opened',
    );
  };
  const chosen = async (id) => {
    await wait(
      `!document.querySelector(${JSON.stringify(query)})`,
      'search closed',
    );
    await paint();
    assert.equal(
      await run(
        `!!document.querySelector('.react-flow__node.selected[data-id="${id}"]')`,
      ),
      true,
    );
    assert.equal(
      await run('!!document.querySelector(".group-stage")'),
      false,
      'Finding never expands a group',
    );
    const delta = await run(
      `(()=>{const area=document.querySelector('.react-flow').getBoundingClientRect();const node=document.querySelector('.react-flow__node[data-id="${id}"]').getBoundingClientRect();return{x:node.x+node.width/2-area.x-area.width/2,y:node.y+node.height/2-area.y-area.height/2}})()`,
    );
    assert.ok(
      Math.hypot(delta.x, delta.y) < 1,
      `Target centered ${JSON.stringify(delta)}`,
    );
    assert.equal(
      await run(`document.activeElement?.dataset.id===${JSON.stringify(id)}`),
      true,
    );
  };
  try {
    await win.loadURL(`${origin}/${basename(scratch)}/index.html`);
    await wait(
      `typeof materialSearch!=='undefined'&&!!document.querySelector(${JSON.stringify(page)})`,
      'canvas ready',
    );
    await paint();
    if (process.env.AFFLATUS_SEARCH_PICKER_ONLY !== '1') {
      const before = (await state()).shot;
      await open();
      await input(query, '城市 早晨');
      await key('Return');
      await chosen('solo');
      assert.equal((await state()).shot.viewport.zoom, before.viewport.zoom);
      console.log(
        'PASS search: native configured shortcut, multiword input and Enter locate the real card with focus',
      );

      await open();
      await input(query, '海边 晨光');
      assert.equal(
        await run(
          'document.querySelectorAll("[data-material-search-id]").length',
        ),
        2,
      );
      writeFileSync(
        '/private/tmp/afflatus-batch20-search.png',
        (await wc.capturePage()).toPNG(),
      );
      await click('[data-material-search-id="member"]');
      await chosen('member');
      await open();
      await input(query, '海边 晨光');
      await click('[data-material-search-id="group"]');
      await chosen('group');
      await open();
      await input(query, '结尾位置');
      await key('Return');
      await chosen('label');
      const after = await state();
      assert.deepEqual(after.shot.nodes, before.nodes);
      assert.deepEqual(after.shot.groups, before.groups);
      assert.deepEqual(after.shot.labels, before.labels);
      assert.equal(after.canUndo, false);
      assert.equal(await run('materialSearch.flush()'), true);
      assert.deepEqual(
        (await state()).stored.shots[0].viewport,
        after.shot.viewport,
      );
      assert.equal(mediaRequests, 0, 'Searching never reads media');
      console.log(
        'PASS search: group-relative card, collapsed group and pinned label locate without changing contents/history; viewport saved',
      );

      await open();
      await input(query, '不存在的内容');
      assert.equal(
        await run(
          'document.querySelectorAll("[data-material-search-id]").length',
        ),
        0,
      );
      await key('Return');
      assert.equal(
        await run(`!!document.querySelector(${JSON.stringify(query)})`),
        true,
      );
      await key('Escape');
      await wait('!document.querySelector("dialog[open]")', 'cancel search');
      const noJump = (await state()).shot.viewport;
      await run('materialSearch.binding(null)');
      await focus(page);
      await key('k', [mod]);
      assert.equal(
        await run('!!document.querySelector("dialog[open]")'),
        false,
      );
      await run(
        "materialSearch.binding({key:'h',mod:false,shift:false,alt:false})",
      );
      await focus(page);
      await key('h');
      await wait(
        `!!document.querySelector(${JSON.stringify(query)})`,
        'custom binding',
      );
      await key('Escape');
      await wait(
        '!document.querySelector("dialog[open]")',
        'custom search closed',
      );
      await run('materialSearch.block(true)');
      await focus(page);
      await key('h');
      assert.equal(
        await run('!!document.querySelector("dialog[open]")'),
        false,
      );
      await run('materialSearch.block(false)');
      assert.deepEqual((await state()).shot.viewport, noJump);
      console.log(
        'PASS search: empty result, cancel, disabled binding, custom binding and project lock preserve canvas',
      );
    }

    await button('项目素材');
    const pickerQuery = 'input[aria-label="搜索项目素材"]';
    await wait(
      `!!document.querySelector(${JSON.stringify(pickerQuery)})`,
      'picker opened',
    );
    const referenceIds = () =>
      run(
        '[...document.querySelectorAll("[data-reference-id]")].map(node=>node.dataset.referenceId)',
      );
    assert.deepEqual(await referenceIds(), [
      'text-b',
      'audio-a',
      'video-a',
      'text-a',
      'image-a',
    ]);
    await selectOption('select[aria-label="素材类型"]', 'text');
    assert.deepEqual(await referenceIds(), ['text-b', 'text-a']);
    await selectOption('select[aria-label="素材排序"]', 'name');
    assert.deepEqual(await referenceIds(), ['text-a', 'text-b']);
    await selectOption('select[aria-label="素材类型"]', 'all');
    await input(pickerQuery, 'ｉｍａｇｅ 晨光');
    await click('[data-reference-id="image-a"]');
    await input(pickerQuery, 'script 分镜');
    await click('[data-reference-id="text-a"]');
    assert.match(
      await run('document.querySelector("dialog[open]").textContent'),
      /已选 2/,
    );
    await button('查看已选');
    writeFileSync(
      '/private/tmp/afflatus-batch20-reference-picker.png',
      (await wc.capturePage()).toPNG(),
    );
    await click('[aria-label="取消选择IMAGE 晨光.png"]');
    await run('materialSearch.block(true)');
    assert.equal(
      await run(
        '[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="添加素材").disabled',
      ),
      true,
    );
    await run('materialSearch.block(false)');
    await button('添加素材');
    await wait('!document.querySelector("dialog[open]")', 'picker applied');
    const added = (await state()).shot.nodes.filter((n) => n.type === 'asset');
    assert.equal(added.length, 1);
    assert.equal(added[0].assetId, 'text-a');
    assert.equal(await run('materialSearch.flush()'), true);
    console.log(
      'PASS picker: normalized query, hidden selection review/removal, live lock and one add through the real canvas',
    );

    const saved = (await state()).shot;
    await button('返回主画布');
    await wait(
      `!document.querySelector(${JSON.stringify(page)})`,
      'canvas returned',
    );
    await run('materialSearch.reopen()');
    await wait(
      `!!document.querySelector(${JSON.stringify(page)})`,
      'canvas reopened',
    );
    assert.deepEqual((await state()).shot, saved);
    if (process.env.AFFLATUS_SEARCH_PICKER_ONLY !== '1')
      assert.ok(
        (await run('searchInputs')).some(
          (event) => event.trusted && event.key.toLowerCase() === 'k',
        ),
      );
    assert.deepEqual(errors, []);
    console.log(
      'PASS search/picker: reopen retains viewport and chosen reference with no renderer errors',
    );
  } catch (error) {
    console.error(error);
    console.error('rendererErrors', errors);
    console.error(
      'pickerState',
      await run(
        'JSON.stringify({text:document.querySelector("dialog[open]")?.textContent,query:document.querySelector("input[aria-label=搜索项目素材]")?.value,refs:[...document.querySelectorAll("[data-reference-id]")].map(e=>e.dataset.referenceId)})',
      ),
    );
    exitCode = 1;
  } finally {
    win.destroy();
    app.exit(exitCode);
  }
});
