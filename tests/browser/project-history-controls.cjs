// Full ProjectCanvas and native input. Only the typed desktop storage boundary is isolated.
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join, resolve } = require('node:path');
const { app, BrowserWindow, protocol } = require('electron');
const { runCases } = require('./project-history-cases.cjs');
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
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>主画布混合历史验收</title><body><div id="root"></div><script>window.historyInputs=[];for(const type of ['keydown','keyup','input','click','pointerdown','pointerup','focusin','blur'])window.addEventListener(type,event=>historyInputs.push({type,key:event.key,trusted:event.isTrusted,target:event.target?.getAttribute?.('aria-label'),button:event.target?.closest?.('[data-native-target]')?.dataset.nativeTarget}),true)</script><script type="module" src="/@fs/${root}/tests/browser/project-history-controls.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const main = 'main[aria-label="视频创作画布"]';
const page = 'section[aria-label$="素材子画布"]';
const shotSelector = (id) => `${main} .react-flow__node[data-id="shot:${id}"]`;

app.whenReady().then(async () => {
  const video = require('./thumbnail-fixture-video.cjs');
  protocol.handle('afflatus-media', (request) => {
    const isImage = new URL(request.url).pathname.endsWith(
      '10000000-0000-4000-8000-000000000003',
    );
    return new Response(
      isImage
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#6ea3b4"/></svg>'
        : video,
      {
        headers: {
          'Content-Type': isImage ? 'image/svg+xml' : 'video/mp4',
          'Access-Control-Allow-Origin': '*',
        },
      },
    );
  });
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const wc = win.webContents;
  const run = (source) => wc.executeJavaScript(source);
  const state = () => run('projectHistory.state()');
  const errors = [];
  let exitCode = 0;
  let number = 0;
  const dragObservations = [];
  wc.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const wait = async (source, label) => {
    for (let index = 0; index < 320; index++) {
      if (await run(source)) return;
      await sleep(25);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const paint = () =>
    run(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(null))))',
    );
  const activate = async () => {
    app.focus({ steal: true });
    win.focus();
    wc.focus();
    await wait('document.hasFocus()', 'native window activation');
  };
  const point = async (selector) =>
    run(`(()=>{
    const selector=${JSON.stringify(selector)},e=document.querySelector(selector);
    if(!e)throw Error('Missing input target: '+selector);
    const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
    const hit=document.elementFromPoint(x,y);
    if(!r.width||!r.height||!e.contains(hit)){
      const bounds=node=>{if(!node)return null;const b=node.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height}};
      const style=getComputedStyle(e);
      throw Error('Native input target obscured: '+JSON.stringify({selector,target:bounds(e),point:{x,y},hit:hit?.outerHTML.slice(0,500),main:bounds(document.querySelector(${JSON.stringify(main)})),flow:bounds(document.querySelector(${JSON.stringify(`${main} .react-flow`)})),viewport:{width:innerWidth,height:innerHeight},style:{display:style.display,visibility:style.visibility,pointerEvents:style.pointerEvents}}));
    }
    return {x,y};
  })()`);
  const click = async (selector) => {
    await activate();
    await wait(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.disabled&&!e.closest('[inert]')})()`,
      `click target ${selector}`,
    );
    const token = String(++number);
    await run(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(e.disabled||e.closest('[inert]'))throw Error('Disabled click target');e.dataset.nativeTarget=${JSON.stringify(token)};e.scrollIntoView({block:'nearest',behavior:'instant'})})()`,
    );
    await paint();
    const at = await point(selector);
    wc.sendInputEvent({ type: 'mouseMove', ...at });
    wc.sendInputEvent({
      type: 'mouseDown',
      ...at,
      button: 'left',
      clickCount: 1,
    });
    wc.sendInputEvent({
      type: 'mouseUp',
      ...at,
      button: 'left',
      clickCount: 1,
    });
    await wait(
      `historyInputs.some(e=>e.type==='click'&&e.trusted&&e.button===${JSON.stringify(token)})`,
      `trusted click ${selector}`,
    );
    await paint();
  };
  const key = async (keyCode, modifiers = []) => {
    const before = await run('historyInputs.length');
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await paint();
    assert.equal(
      await run(
        `historyInputs.slice(${before}).filter(e=>e.type==='keydown'&&e.trusted).length`,
      ),
      1,
    );
  };
  const input = async (selector, value) => {
    await activate();
    await run(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||e.readOnly||e.closest('[inert]'))throw Error('Text input unavailable');e.focus({preventScroll:true});e.setSelectionRange(0,e.value.length)})()`,
    );
    await wait(
      `document.activeElement===document.querySelector(${JSON.stringify(selector)})`,
      `text focus ${selector}`,
    );
    const before = await run('historyInputs.length');
    await wc.insertText(value);
    await paint();
    assert.equal(
      await run(`document.querySelector(${JSON.stringify(selector)}).value`),
      value,
    );
    assert.equal(
      await run(
        `historyInputs.slice(${before}).some(e=>e.type==='input'&&e.trusted)`,
      ),
      true,
    );
  };
  const button = async (label, scope = page) => {
    const token = `button-${++number}`;
    await run(
      `(()=>{const found=[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].filter(e=>e.textContent.trim()===${JSON.stringify(label)});if(found.length!==1)throw Error('Expected one button '+${JSON.stringify(label)}+' got '+found.length);found[0].dataset.historyButton=${JSON.stringify(token)}})()`,
    );
    await click(`[data-history-button="${token}"]`);
  };
  const rawDrag = async (from, to, beforeRelease) => {
    await activate();
    wc.sendInputEvent({ type: 'mouseMove', ...from });
    wc.sendInputEvent({
      type: 'mouseDown',
      ...from,
      button: 'left',
      clickCount: 1,
    });
    let observed;
    try {
      for (let step = 1; step <= 12; step++) {
        wc.sendInputEvent({
          type: 'mouseMove',
          x: Math.round(from.x + ((to.x - from.x) * step) / 12),
          y: Math.round(from.y + ((to.y - from.y) * step) / 12),
          buttons: ['left'],
        });
        await sleep(8);
      }
      await paint();
      observed = await beforeRelease?.();
    } finally {
      wc.sendInputEvent({
        type: 'mouseUp',
        ...to,
        button: 'left',
        clickCount: 1,
      });
      await paint();
    }
    return observed;
  };
  // Reveal by the actual left-button canvas pan, never by writing React Flow state.
  const reveal = async (selector) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const plan = await run(`(()=>{
        const target=document.querySelector(${JSON.stringify(selector)}),pane=document.querySelector(${JSON.stringify(`${main} .react-flow__pane`)});
        if(!target||!pane)throw Error('Missing pan target');const r=target.getBoundingClientRect(),p=pane.getBoundingClientRect();
        const cx=r.x+r.width/2,cy=r.y+r.height/2;
        if(cx>p.left+90&&cx<p.right-90&&cy>p.top+100&&cy<p.bottom-100)return null;
        const dx=Math.round(Math.max(-260,Math.min(260,p.x+p.width/2-cx))),dy=Math.round(Math.max(-260,Math.min(260,p.y+p.height/2-cy)));
        for(const xPart of [.2,.4,.6,.8])for(const yPart of [.3,.5,.7]){
          const x=Math.round(p.x+p.width*xPart),y=Math.round(p.y+p.height*yPart),hit=document.elementFromPoint(x,y);
          if(hit===pane&&x+dx>p.left+35&&x+dx<p.right-35&&y+dy>p.top+60&&y+dy<p.bottom-60)return {from:{x,y},to:{x:x+dx,y:y+dy}};
        }throw Error('No safe blank pan starting point');
      })()`);
      if (!plan) return;
      await rawDrag(plan.from, plan.to);
    }
    throw new Error(`Unable to reveal ${selector}`);
  };
  // Pointer deltas are screen CSS pixels. React Flow starts its offset only
  // after the drag threshold; the node's own CSS translation is the observed
  // canvas coordinate, independent of the parent's pan/zoom transform.
  const observeNode = (selector) =>
    run(`(()=>{
    const target=document.querySelector(${JSON.stringify(selector)}),node=target?.closest('.react-flow__node');
    const viewport=node?.closest('.react-flow__viewport');
    if(!node||!viewport)throw Error('Missing dragged node/viewport');
    const position=new DOMMatrixReadOnly(getComputedStyle(node).transform),camera=new DOMMatrixReadOnly(getComputedStyle(viewport).transform);
    if(camera.b!==0||camera.c!==0||camera.a<=0||camera.a!==camera.d)throw Error('Unexpected nonuniform canvas transform');
    const surface=node.querySelector('article')??node,r=surface.getBoundingClientRect();
    return {id:node.dataset.id,position:{x:position.e,y:position.f},screen:{left:r.left,top:r.top,width:r.width,height:r.height},camera:{x:camera.e,y:camera.f,zoom:camera.a},dragging:node.classList.contains('dragging'),status:[...document.querySelectorAll(${JSON.stringify(`${main} [role="status"]`)})].map(e=>e.textContent.trim())};
  })()`);
  const drag = async (selector, dx, dy) => {
    await reveal(selector);
    const from = await point(selector);
    const before = await observeNode(selector);
    const to = {
      x: Math.round(from.x + dx),
      y: Math.round(from.y + dy),
    };
    const drop = await rawDrag(from, to, () => observeNode(selector));
    const observed = { selector, pointer: { from, to }, before, drop };
    dragObservations.push(observed);
    assert.equal(
      drop.dragging,
      true,
      'The native movement really started a node drag',
    );
    assert.equal(drop.id, before.id);
    assert.ok(
      Math.hypot(
        drop.position.x - before.position.x,
        drop.position.y - before.position.y,
      ) *
        drop.camera.zoom >
        5,
      'The node really moved beyond the screen-space drag threshold',
    );
    return observed;
  };
  const openShot = async (id) => {
    const selector = `${shotSelector(id)} button`;
    await reveal(selector);
    await click(selector);
    await wait(
      `!!document.querySelector(${JSON.stringify(page)})`,
      `shot opens ${id}`,
    );
    await paint();
  };
  const back = async () => {
    await button('返回主画布');
    await wait(
      `!document.querySelector(${JSON.stringify(page)})`,
      'child save completes before return',
    );
  };
  const mainHistory = async (label) => {
    const selector = `${main} fieldset[aria-label="画布操作"] button[aria-label="${label}"]`;
    await wait(
      `document.querySelector(${JSON.stringify(selector)})?.disabled===false`,
      `${label} available`,
    );
    await click(selector);
  };
  const remove = async (id) => {
    const target = `${shotSelector(id)} article > div`;
    await reveal(target);
    await click(target);
    await click(`${main} button[aria-label="移除镜头"]`);
  };
  const load = async () => {
    await win.loadURL(`${origin}/${basename(scratch)}/index.html`);
    await wait(
      `typeof projectHistory!=='undefined'&&!!document.querySelector(${JSON.stringify(shotSelector('seed-shot'))})`,
      'real ProjectCanvas ready',
    );
    await wait(
      `(()=>{const main=document.querySelector(${JSON.stringify(main)}),flow=document.querySelector(${JSON.stringify(`${main} .react-flow`)});if(!main||!flow)return false;const m=main.getBoundingClientRect(),f=flow.getBoundingClientRect();return m.width>0&&m.height>0&&Math.abs(m.height-innerHeight)<=2&&Math.abs(m.width-innerWidth)<=2&&Math.abs(f.height-m.height)<=2&&Math.abs(f.width-m.width)<=2})()`,
      'full-height fixture main and React Flow have visible viewport dimensions',
    );
    await activate();
    await paint();
  };
  try {
    await runCases({
      run,
      state,
      wait,
      paint,
      click,
      key,
      input,
      button,
      drag,
      reveal,
      openShot,
      back,
      mainHistory,
      remove,
      load,
      main,
      page,
      shotSelector,
    });
    assert.deepEqual(errors, []);
    if (process.env.AFFLATUS_HISTORY_SCREENSHOT) {
      const file = resolve(process.env.AFFLATUS_HISTORY_SCREENSHOT);
      writeFileSync(file, (await wc.capturePage()).toPNG());
      console.log(`Project history screenshot: ${file}`);
    }
  } catch (error) {
    exitCode = 1;
    console.error(error);
    console.error('renderer errors', errors);
    console.error('observed native drags', dragObservations);
    try {
      console.error(
        'history diagnostics',
        await run(
          `(()=>{const s=typeof projectHistory==='undefined'?null:projectHistory.state();return {focused:document.hasFocus(),active:document.activeElement?.outerHTML?.slice(0,400),geometry:['html','body','#root','#root > div','main','.react-flow'].map(selector=>{const e=document.querySelector(selector);if(!e)return {selector,missing:true};const r=e.getBoundingClientRect(),css=getComputedStyle(e);return {selector,x:r.x,y:r.y,width:r.width,height:r.height,display:css.display,cssHeight:css.height}}),viewport:{width:innerWidth,height:innerHeight},inert:[...document.querySelectorAll('[inert]')].map(e=>e.getAttribute('aria-label')),dialogs:[...document.querySelectorAll('dialog')].map(e=>({open:e.open,modal:e.matches(':modal')})),buttons:[...document.querySelectorAll('button')].filter(e=>['撤销','重做','移除镜头','重试镜头数据'].includes(e.getAttribute('aria-label'))).map(e=>({label:e.getAttribute('aria-label'),disabled:e.disabled})),state:s,inputs:historyInputs.slice(-35)}})()`,
        ),
      );
      const file = join(tmpdir(), 'afflatus-project-history-failure.png');
      writeFileSync(file, (await wc.capturePage()).toPNG());
      console.error(`Failure screenshot: ${file}`);
    } catch (diagnosticError) {
      console.error('diagnostic error', diagnosticError);
    }
  } finally {
    win.destroy();
    app.exit(exitCode);
  }
});
