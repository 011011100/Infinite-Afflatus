// Real material canvas and save queue; only desktop storage/media are isolated.
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
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
  `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>镜头复用验收</title><body><div id="root"></div><script>window.reuseInputs=[];for(const type of ['keydown','keyup','input','click'])window.addEventListener(type,event=>reuseInputs.push({type,key:event.key,trusted:event.isTrusted,target:event.target?.getAttribute?.('aria-label'),button:event.target?.closest?.('[data-native-target]')?.dataset.nativeTarget}),true)</script><script type="module" src="/@fs/${root}/tests/browser/shot-reuse-controls.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const page = 'section[aria-label$="素材子画布"]';
const rename = `${page} button[aria-label="重命名镜头名称"]`;
const nameInput = `${page} input[aria-label="镜头名称"]`;
const textarea = (id) => `.react-flow__node[data-id="${id}"] textarea`;
const shape = (shot) => ({
  nodes: shot.nodes.map(({ id: _, groupId, ...node }) => ({
    ...node,
    ...(groupId === undefined
      ? {}
      : { groupIndex: shot.groups.findIndex((group) => group.id === groupId) }),
  })),
  groups: shot.groups.map(({ id: _, ...group }) => group),
  labels: shot.labels?.map(({ id: _, ...label }) => label),
});
function assertCopy(source, copy) {
  const ids = (shot) => [
    shot.id,
    ...shot.nodes.map((node) => node.id),
    ...shot.groups.map((group) => group.id),
    ...(shot.labels ?? []).map((label) => label.id),
  ];
  const originalIds = new Set(ids(source));
  assert.equal(new Set(ids(copy)).size, ids(copy).length);
  assert.ok(ids(copy).every((id) => !originalIds.has(id)));
  assert.equal(Object.hasOwn(copy, 'sourceAssetId'), false);
  assert.equal(source.sourceAssetId, 'generated-video');
  assert.equal(copy.name, `${source.name} 副本`);
  assert.deepEqual(copy.position, { x: 560, y: 200 });
  assert.deepEqual(copy.viewport, source.viewport);
  assert.deepEqual(shape(copy), shape(source));
}

app.whenReady().then(async () => {
  protocol.handle(
    'afflatus-media',
    () =>
      new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#6ea3b4"/></svg>',
        { headers: { 'Content-Type': 'image/svg+xml' } },
      ),
  );
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const wc = win.webContents;
  const run = (source) => wc.executeJavaScript(source);
  const state = () => run('shotReuse.state()');
  const errors = [];
  let exitCode = 0;
  wc.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const paint = () =>
    run(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(null))))',
    );
  const wait = async (source, label) => {
    for (let index = 0; index < 320; index++) {
      if (await run(source)) return;
      await sleep(25);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const activate = async () => {
    app.focus({ steal: true });
    win.focus();
    wc.focus();
    await wait('document.hasFocus()', 'native activation');
  };
  const focus = async (selector) => {
    await activate();
    await wait(
      `!!document.querySelector(${JSON.stringify(selector)})`,
      `focus target exists ${selector}`,
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
    const before = await run('reuseInputs.length');
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await paint();
    assert.equal(
      await run(
        `reuseInputs.slice(${before}).filter(e=>e.type==='keydown'&&e.trusted).length`,
      ),
      1,
      'One real keyboard press reached the page',
    );
  };
  let targetNumber = 0;
  const click = async (selector) => {
    await activate();
    await wait(
      `!!document.querySelector(${JSON.stringify(selector)})`,
      `click target exists ${selector}`,
    );
    const token = String(++targetNumber);
    await run(`(()=>{
      const e=document.querySelector(${JSON.stringify(selector)});
      if(e.disabled || e.closest('[inert]'))throw Error('Disabled native click target');
      e.dataset.nativeTarget=${JSON.stringify(token)};
      e.scrollIntoView({block:'nearest',behavior:'instant'});
    })()`);
    await paint();
    const point = await run(`(()=>{
      const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
      const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
      if(!r.width || !r.height || !e.contains(document.elementFromPoint(x,y)))throw Error('Native click target obscured');
      return {x,y};
    })()`);
    wc.sendInputEvent({ type: 'mouseMove', ...point });
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
    await wait(
      `reuseInputs.some(e=>e.type==='click'&&e.trusted&&e.button===${JSON.stringify(token)})`,
      `trusted click ${selector}`,
    );
    await paint();
  };
  const buttonSelector = async (label) => {
    const token = `label-${++targetNumber}`;
    await run(`(()=>{
      const e=[...document.querySelectorAll(${JSON.stringify(`${page} button`)})].find(e=>e.textContent.trim()===${JSON.stringify(label)});
      if(!e)throw Error('Missing button '+${JSON.stringify(label)});
      e.dataset.reuseButton=${JSON.stringify(token)};
    })()`);
    return `[data-reuse-button="${token}"]`;
  };
  const button = async (label) => click(await buttonSelector(label));
  const input = async (selector, value) => {
    await focus(selector);
    await run(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.setSelectionRange(0,e.value.length)})()`,
    );
    const before = await run('reuseInputs.length');
    await wc.insertText(value);
    await paint();
    assert.equal(
      await run(`document.querySelector(${JSON.stringify(selector)}).value`),
      value,
    );
    assert.equal(
      await run(
        `reuseInputs.slice(${before}).some(e=>e.type==='input'&&e.trusted)`,
      ),
      true,
    );
  };
  const load = async (mode = 'normal') => {
    await win.loadURL(`${origin}/${basename(scratch)}/index.html?mode=${mode}`);
    await wait(
      `typeof shotReuse!=='undefined'&&shotReuse.state().activeId==='source-shot'&&!!document.querySelector(${JSON.stringify(rename)})`,
      `ready ${mode}`,
    );
    await activate();
    await paint();
  };
  const copyComplete = () =>
    wait(
      "shotReuse.state().activeId!=='source-shot'&&shotReuse.state().stored.shots.length===2",
      'saved copy opens',
    );
  try {
    await load();
    const original = (await state()).shots[0];
    await click(rename);
    await input(nameInput, '雨夜改名');
    await key('Return');
    await wait(
      "shotReuse.state().shots[0].name==='雨夜改名'",
      'rename committed',
    );
    await click(`${page} button[aria-label="撤销"]`);
    await wait("shotReuse.state().shots[0].name==='雨夜镜头'", 'name undo');
    await click(`${page} button[aria-label="重做"]`);
    await wait("shotReuse.state().shots[0].name==='雨夜改名'", 'name redo');
    assert.deepEqual(shape((await state()).shots[0]), shape(original));
    assert.equal(await run('shotReuse.flush()'), true);
    assert.equal((await state()).stored.shots[0].name, '雨夜改名');
    console.log(
      'PASS shot reuse: real name input, Enter, undo/redo and save preserve materials and parameters',
    );

    await input(textarea('solo'), '复制前的最新正文');
    await wait(
      "shotReuse.state().shots[0].nodes[0].text==='复制前的最新正文'",
      'text reached real workspace',
    );
    await click(rename);
    await input(nameInput, '未按回车的新镜头名');
    assert.equal((await state()).shots[0].name, '雨夜改名');
    await button('复制镜头');
    await copyComplete();
    const copied = await state();
    const sourceAfter = copied.shots[0];
    const copy = copied.shots[1];
    assert.equal(sourceAfter.name, '未按回车的新镜头名');
    assert.equal(sourceAfter.nodes[0].text, '复制前的最新正文');
    assertCopy(sourceAfter, copy);
    assert.deepEqual(copied.stored.shots, copied.shots);
    assert.equal(copied.histories[copy.id].canUndo, false);
    console.log(
      'PASS shot reuse: copy flushes unconfirmed name and latest text, remaps identities and preserves both group parameter types and shared references',
    );
    if (process.env.AFFLATUS_REUSE_SCREENSHOT) {
      await paint();
      const file = resolve(process.env.AFFLATUS_REUSE_SCREENSHOT);
      writeFileSync(file, (await wc.capturePage()).toPNG());
      console.log(`Shot reuse screenshot: ${file}`);
    }

    const copyText = copy.nodes[0];
    await input(textarea(copyText.id), '仅修改副本的正文');
    await wait(
      `shotReuse.state().shots[1].nodes[0].text==='仅修改副本的正文'`,
      'copy edit',
    );
    await click(`${page} button[aria-label="撤销"]`);
    await wait(
      `shotReuse.state().shots[1].nodes[0].text===${JSON.stringify(copyText.text)}`,
      'copy undo',
    );
    await click(`${page} button[aria-label="重做"]`);
    await wait(
      "shotReuse.state().shots[1].nodes[0].text==='仅修改副本的正文'",
      'copy redo',
    );
    assert.deepEqual((await state()).shots[0], sourceAfter);
    await button('返回主画布');
    await wait('shotReuse.state().activeId===null', 'saved copy closes');
    const savedCopy = (await state()).stored.shots[1];
    await click('[data-open-shot="source-shot"]');
    await wait(
      "shotReuse.state().activeId==='source-shot'",
      'original reopens',
    );
    await click(`${page} button[aria-label="撤销"]`);
    await wait(
      "shotReuse.state().shots[0].name==='雨夜改名'",
      'original keeps its own name history',
    );
    assert.deepEqual((await state()).shots[1], savedCopy);
    assert.equal((await state()).shots[0].nodes[0].text, '复制前的最新正文');
    console.log(
      'PASS shot reuse: later copy edits/undo/redo never mutate original content or its independent undo stack',
    );

    await load('copy-failure');
    const failureSource = (await state()).shots[0];
    await button('复制镜头');
    await wait(
      'shotReuse.state().copyWritePending',
      'real copy write is pending',
    );
    const waiting = await state();
    assert.equal(waiting.activeId, 'source-shot');
    assert.equal(waiting.shots.length, 2);
    const candidateId = waiting.shots[1].id;
    assert.equal(
      await run(`document.querySelector(${JSON.stringify(page)}).inert`),
      true,
    );
    await run(
      `document.querySelector(${JSON.stringify(textarea('solo'))}).focus()`,
    );
    assert.equal(
      await run(
        `document.activeElement===document.querySelector(${JSON.stringify(textarea('solo'))})`,
      ),
      false,
    );
    await wc.insertText('保存期间不能输入');
    assert.deepEqual((await state()).shots[0], failureSource);
    await run('shotReuse.releaseCopy();void 0');
    await wait(
      `shotReuse.state().duplicatePending&&!document.querySelector(${JSON.stringify(page)}).inert&&shotReuse.state().error==='副本保存注入失败'`,
      'failed copy stays on original and unlocks',
    );
    assert.equal((await state()).stored.shots.length, 1);
    await button('继续打开副本');
    await wait(
      `!document.querySelector(${JSON.stringify(page)}).inert`,
      'second failure unlocks',
    );
    const retried = await state();
    assert.equal(retried.activeId, 'source-shot');
    assert.equal(retried.shots.length, 2);
    assert.equal(retried.shots[1].id, candidateId);
    await run('shotReuse.allowWrites();void 0');
    await button('继续打开副本');
    await copyComplete();
    const settled = await state();
    assert.equal(settled.activeId, candidateId);
    assert.equal(settled.duplicatePending, false);
    assert.equal(settled.shots.length, 2);
    assert.ok(
      settled.attempts
        .filter((doc) => doc.shots.length === 2)
        .every((doc) => doc.shots[1].id === candidateId),
    );
    assert.deepEqual(settled.shots[0], failureSource);
    console.log(
      'PASS shot reuse: deferred write keeps the page inert; failure preserves original view and repeated retry saves exactly one candidate ID',
    );

    await load('source-failure');
    await input(textarea('solo'), '原稿写失败仍保留输入');
    await button('复制镜头');
    await wait(
      `shotReuse.state().error==='原稿保存注入失败'&&!document.querySelector(${JSON.stringify(page)}).inert`,
      'source failure releases copy lock',
    );
    assert.equal((await state()).activeId, 'source-shot');
    assert.equal((await state()).shots.length, 1);
    assert.equal(
      (await state()).stored.shots[0].nodes[0].text,
      '原镜头独立文字',
    );
    assert.equal(
      (await state()).shots[0].nodes[0].text,
      '原稿写失败仍保留输入',
    );
    await run('shotReuse.allowWrites();void 0');
    await button('复制镜头');
    await copyComplete();
    assert.equal(
      (await state()).stored.shots[1].nodes[0].text,
      '原稿写失败仍保留输入',
    );
    console.log(
      'PASS shot reuse: source flush failure cannot create/open a copy or lose dirty text; explicit retry copies the preserved input',
    );

    await load();
    await click(rename);
    await input(nameInput, '受保护的镜头名');
    await run('shotReuse.block(true);void 0');
    await paint();
    assert.equal(
      await run(
        `document.querySelector(${JSON.stringify(nameInput)}).readOnly`,
      ),
      true,
    );
    const blockedCopy = await buttonSelector('复制镜头');
    assert.equal(
      await run(
        `document.querySelector(${JSON.stringify(blockedCopy)}).disabled`,
      ),
      true,
    );
    await key('Return');
    assert.equal((await state()).shots[0].name, '雨夜镜头');
    assert.equal(
      await run(`document.querySelector(${JSON.stringify(nameInput)}).value`),
      '受保护的镜头名',
    );
    assert.equal((await state()).attempts.length, 0);
    await run('shotReuse.block(false);void 0');
    await paint();
    await key('Return');
    await wait(
      "shotReuse.state().shots[0].name==='受保护的镜头名'",
      'unblocked name commits',
    );
    console.log(
      'PASS shot reuse: blocked copy/name controls retain raw input and do not write; unlocking preserves the pending name',
    );

    await load('capacity');
    const full = (await state()).shots;
    assert.equal(full.length, 500);
    await button('复制镜头');
    await wait(
      `document.body.textContent.includes('500')&&!document.querySelector(${JSON.stringify(page)}).inert`,
      'capacity error visible and page unlocked',
    );
    assert.equal((await state()).activeId, 'source-shot');
    assert.deepEqual((await state()).shots, full);
    assert.deepEqual((await state()).stored.shots, full);
    assert.equal((await state()).attempts.length, 0);
    assert.equal((await state()).duplicatePending, false);
    console.log(
      'PASS shot reuse: the 500-shot limit rejects copy without append, writes, navigation or a lingering lock',
    );

    await load();
    await click(rename);
    await input(nameInput, '组合输入中的名称');
    await run(
      `document.querySelector(${JSON.stringify(nameInput)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true,cancelable:true}));void 0`,
    );
    await paint();
    assert.equal(
      await run(`document.querySelector(${JSON.stringify(nameInput)})?.value`),
      '组合输入中的名称',
    );
    assert.equal((await state()).shots[0].name, '雨夜镜头');
    await key('Escape');
    await wait(
      `!document.querySelector(${JSON.stringify(nameInput)})`,
      'native Escape cancels name input',
    );
    assert.equal((await state()).shots[0].name, '雨夜镜头');
    assert.equal((await state()).activeId, 'source-shot');
    console.log(
      'PASS shot reuse: DOM composition guard preserves name input; native Escape outside composition cancels without closing the canvas (not live IME validation)',
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    exitCode = 1;
    console.error(error);
    console.error('renderer errors', errors);
    try {
      console.error(
        'reuse diagnostics',
        await run(`(()=>{
        const s=typeof shotReuse==='undefined'?null:shotReuse.state();
        return {focused:document.hasFocus(),active:document.activeElement?.outerHTML?.slice(0,500),pageInert:document.querySelector(${JSON.stringify(page)})?.inert,dialogs:[...document.querySelectorAll('dialog')].map(d=>({open:d.open,modal:d.matches(':modal')})),state:s&&{activeId:s.activeId,count:s.shots.length,names:s.shots.slice(0,3).map(x=>({id:x.id,name:x.name})),storedCount:s.stored.shots.length,error:s.error,duplicatePending:s.duplicatePending,copyWritePending:s.copyWritePending,attempts:s.attempts.map(d=>({revision:d.revision,ids:d.shots.slice(0,3).map(x=>x.id),count:d.shots.length}))},inputs:reuseInputs.slice(-30)};
      })()`),
      );
    } catch (diagnosticError) {
      console.error('diagnostic error', diagnosticError);
    }
    try {
      const file = join(tmpdir(), 'afflatus-shot-reuse-failure.png');
      writeFileSync(file, (await wc.capturePage()).toPNG());
      console.error(`Failure screenshot: ${file}`);
    } catch (screenshotError) {
      console.error('failure screenshot error', screenshotError);
    }
  } finally {
    win.destroy();
    app.exit(exitCode);
  }
});
