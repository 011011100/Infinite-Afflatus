// Real MaterialCanvas, React Flow, ShotHistory and workspace save queue; typed IPC storage is isolated in memory.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = resolve(__dirname, '../..');
const origin = process.env.AFFLATUS_FIXTURE_ORIGIN;
if (!origin) throw new Error('Use the isolated fixture runner');
const scratch =
  process.env.AFFLATUS_FIXTURE_SCRATCH ??
  mkdtempSync(join(root, 'src/renderer/.material-keyboard-controls-'));
const profile =
  process.env.AFFLATUS_FIXTURE_PROFILE ??
  mkdtempSync(join(tmpdir(), 'afflatus-material-keyboard-controls-'));
app.setPath('userData', profile);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>素材键盘回归</title></head><body><div id="root"></div><script>window.materialInputEvents=[];window.addEventListener('keydown',event=>materialInputEvents.push({key:event.key,repeat:event.repeat,trusted:event.isTrusted}),true);window.materialPointerEvents=[];for(const type of ['mousedown','mouseup','click'])window.addEventListener(type,event=>materialPointerEvents.push({type,trusted:event.isTrusted,label:event.target.closest?.('[data-label-id]')?.dataset.labelId??null}),true)</script><script type="module" src="/@fs/${root}/tests/browser/material-keyboard-controls.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 950,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const wc = win.webContents;
  const run = (source) => wc.executeJavaScript(source);
  const errors = [];
  wc.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const state = () => run('materialKeys.state()');
  const painted = () =>
    run(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
  const configure = async (source) => {
    await run(source);
    await painted();
  };
  const node = (id) => `.react-flow__node[data-id="${id}"]`;
  const page = 'section[aria-label="键盘镜头素材子画布"]';
  const wait = async (source, label) => {
    for (let i = 0; i < 300; i++) {
      if (await run(source)) return;
      await sleep(20);
    }
    throw Error(`Timed out: ${label}`);
  };
  const focus = async (selector) => {
    win.focus();
    wc.focus();
    await run(
      `document.querySelector(${JSON.stringify(selector)}).focus({preventScroll:true})`,
    );
    try {
      await wait(
        `document.hasFocus()&&document.activeElement===document.querySelector(${JSON.stringify(selector)})`,
        `focus ${selector}`,
      );
    } catch (error) {
      console.error(
        'focus diagnostic',
        await run(
          `(()=>{const target=document.querySelector(${JSON.stringify(selector)});return {focused:document.hasFocus(),active:document.activeElement?.outerHTML.slice(0,600),target:target?.outerHTML.slice(0,600),inert:!!target?.closest('[inert]'),dialogs:[...document.querySelectorAll('dialog')].map(d=>d.outerHTML.slice(0,120))}})()`,
        ),
      );
      throw error;
    }
  };
  const key = async (keyCode, modifiers = [], repeat = false) => {
    const count = await run('materialInputEvents.length');
    wc.sendInputEvent({
      type: 'keyDown',
      keyCode,
      modifiers: repeat ? [...modifiers, 'isautorepeat'] : modifiers,
    });
    if (keyCode === 'Return' || keyCode === 'Space')
      wc.sendInputEvent({
        type: 'char',
        keyCode: keyCode === 'Return' ? '\r' : ' ',
        modifiers: repeat ? [...modifiers, 'isautorepeat'] : modifiers,
      });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await sleep(50);
    await wait(
      `materialInputEvents.length===${count + 1}`,
      'one native keydown delivered',
    );
    const input = await run('materialInputEvents.at(-1)');
    assert.equal(input.trusted, true);
    assert.equal(input.repeat, repeat, `actual repeat flag for ${keyCode}`);
  };
  const select = async (id) => {
    await run('document.querySelector(".react-flow__pane").click()');
    await painted();
    await focus(node(id));
    await key('Return');
    await wait(
      `document.querySelector(${JSON.stringify(node(id))}).classList.contains('selected')`,
      `Enter selects ${id}`,
    );
  };
  const position = async (id, stored = false) => {
    const result = await state();
    const shot = stored ? result.stored.shots[0] : result.current;
    return [...shot.nodes, ...shot.groups, ...shot.labels].find(
      (item) => item.id === id,
    ).position;
  };
  const rendered = (id) =>
    run(
      `(()=>{const m=new DOMMatrix(getComputedStyle(document.querySelector(${JSON.stringify(node(id))})).transform);return {x:m.m41,y:m.m42}})()`,
    );
  const unchanged = async (id, before, domBefore) => {
    assert.deepEqual(await position(id), before);
    assert.deepEqual(await rendered(id), domBefore);
  };
  let failed = false;
  try {
    await win.loadURL(`${origin}/${basename(scratch)}/index.html`);
    await wait(
      'typeof materialKeys!=="undefined"&&!!document.querySelector(".react-flow__node[data-id=solo]")',
      'material canvas mounted',
    );
    await select('solo');
    const original = await position('solo');
    await key('Right');
    assert.deepEqual(await position('solo'), {
      x: original.x + 5,
      y: original.y,
    });
    await key('Down', ['shift']);
    const moved = { x: original.x + 5, y: original.y + 20 };
    assert.deepEqual(await position('solo'), moved);
    assert.deepEqual(await rendered('solo'), moved);
    assert.equal(await run('materialKeys.flush()'), true);
    assert.deepEqual(await position('solo', true), moved);
    console.log(
      'PASS native Enter preserves React Flow selection; Arrow and Shift+Arrow move 5/20 units and persist the displayed coordinates',
    );

    await key('z', [process.platform === 'darwin' ? 'meta' : 'control']);
    assert.deepEqual(await position('solo'), {
      x: original.x + 5,
      y: original.y,
    });
    await key('z', [process.platform === 'darwin' ? 'meta' : 'control']);
    assert.deepEqual(await position('solo'), original);
    await key('z', [
      process.platform === 'darwin' ? 'meta' : 'control',
      'shift',
    ]);
    assert.deepEqual(await position('solo'), {
      x: original.x + 5,
      y: original.y,
    });
    await key('z', [
      process.platform === 'darwin' ? 'meta' : 'control',
      'shift',
    ]);
    assert.deepEqual(await position('solo'), moved);
    console.log(
      'PASS each discrete move is one undo step and redo restores the exact position',
    );

    await select('solo');
    const domMoved = await rendered('solo');
    await key('Right', [], true);
    await unchanged('solo', moved, domMoved);
    await configure('materialKeys.binding("moveRight",null)');
    await key('Right');
    await unchanged('solo', moved, domMoved);
    await configure(
      'materialKeys.binding("moveRight",{key:"d",mod:false,shift:false,alt:false})',
    );
    await key('Right');
    await unchanged('solo', moved, domMoved);
    await key('d');
    assert.deepEqual(await position('solo'), { x: moved.x + 5, y: moved.y });
    await key('d', [], true);
    assert.deepEqual(await position('solo'), { x: moved.x + 5, y: moved.y });
    await configure(
      'materialKeys.binding("play",null);materialKeys.binding("moveRight",{key:"Space",mod:false,shift:false,alt:false})',
    );
    await focus(node('child-a'));
    await key('Space', [], true);
    assert.equal(
      await run(
        'document.querySelector("[data-id=child-a]").classList.contains("selected")',
      ),
      false,
    );
    assert.deepEqual(await position('solo'), { x: moved.x + 5, y: moved.y });
    await key('Space');
    assert.deepEqual(await position('solo'), { x: moved.x + 10, y: moved.y });
    await configure('materialKeys.defaults()');
    console.log(
      'PASS repeat, cleared and remapped arrows cannot leak transient React Flow movement; custom key moves once',
    );

    await focus(node('solo'));
    const beforeTab = await run(
      'document.activeElement.getAttribute("data-id")',
    );
    await key('Tab');
    assert.equal(beforeTab, 'solo');
    assert.equal(
      await run(
        `document.activeElement===document.querySelector(${JSON.stringify(node('solo'))})`,
      ),
      false,
    );
    const controlsBefore = await position('solo');
    const controlsDom = await rendered('solo');
    await focus(`${node('solo')} textarea`);
    await run('document.activeElement.setSelectionRange(2,2)');
    await key('Left');
    assert.equal(await run('document.activeElement.selectionStart'), 1);
    await unchanged('solo', controlsBefore, controlsDom);
    await focus(`${node('solo')} button[aria-label="移除文本卡片"]`);
    await key('Right');
    await unchanged('solo', controlsBefore, controlsDom);
    await focus(`${node('solo')} button[aria-label="调整卡片大小"]`);
    const beforeWidth =
      (await state()).current.nodes.find((item) => item.id === 'solo').width ??
      260;
    await key('Right');
    assert.equal(
      (await state()).current.nodes.find((item) => item.id === 'solo').width,
      beforeWidth + 10,
    );
    await unchanged('solo', controlsBefore, controlsDom);
    console.log(
      'PASS Tab navigation and text caret keys stay native; focused buttons do not move cards and resize control retains its own arrow behavior',
    );

    // An in-node slider probe exercises the shared control boundary without adding production UI.
    await run(
      `(()=>{const slider=document.createElement('div');slider.id='slider-probe';slider.tabIndex=0;slider.role='slider';slider.setAttribute('aria-valuenow','0');slider.addEventListener('keydown',e=>{if(e.key==='ArrowRight')slider.setAttribute('aria-valuenow','1')});document.querySelector(${JSON.stringify(`${node('solo')} .material-card`)}).append(slider)})()`,
    );
    await focus('#slider-probe');
    await key('Right');
    assert.equal(
      await run(
        'document.querySelector("#slider-probe").getAttribute("aria-valuenow")',
      ),
      '1',
    );
    await unchanged('solo', controlsBefore, controlsDom);
    await run('document.querySelector("#slider-probe").remove()');
    await focus(node('solo'));
    await run(
      `document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',isComposing:true,bubbles:true,cancelable:true}))`,
    );
    await unchanged('solo', controlsBefore, controlsDom);
    await configure('materialKeys.dialog(true)');
    await wait('!!document.querySelector("dialog[open]")', 'dialog mounted');
    await focus(node('solo'));
    await key('Right');
    await unchanged('solo', controlsBefore, controlsDom);
    await configure('materialKeys.dialog(false)');
    await run(
      `document.querySelector(${JSON.stringify(page)}).dispatchEvent(new PointerEvent('pointerdown',{pointerId:71,button:0,bubbles:true}))`,
    );
    await key('Right');
    await unchanged('solo', controlsBefore, controlsDom);
    await run(
      `window.dispatchEvent(new PointerEvent('pointerup',{pointerId:71}))`,
    );
    await configure('materialKeys.block(true)');
    await wait('materialKeys.state().blocked', 'write lock active');
    await focus(node('solo'));
    await key('Right');
    await unchanged('solo', controlsBefore, controlsDom);
    await configure('materialKeys.block(false)');
    console.log(
      'PASS slider, IME, open dialog, active pointer and write lock prevent both durable and temporary movement',
    );

    await select('group');
    const groupBefore = await position('group');
    const childBefore = await position('child-a');
    const childDomBefore = await rendered('child-a');
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    wc.sendInputEvent({ type: 'keyDown', keyCode: modifier });
    await focus(node('child-a'));
    await key('Return', [process.platform === 'darwin' ? 'meta' : 'control']);
    wc.sendInputEvent({ type: 'keyUp', keyCode: modifier });
    await wait(
      'document.querySelector("[data-id=group]").classList.contains("selected")&&document.querySelector("[data-id=child-a]").classList.contains("selected")',
      'parent and child both selected',
    );
    await key('Right');
    assert.deepEqual(await position('group'), {
      x: groupBefore.x + 5,
      y: groupBefore.y,
    });
    assert.deepEqual(await position('child-a'), childBefore);
    assert.deepEqual(await rendered('child-a'), {
      x: childDomBefore.x + 5,
      y: childDomBefore.y,
    });
    assert.equal(
      (await state()).current.nodes.find((item) => item.id === 'child-a')
        .groupId,
      'group',
    );
    console.log(
      'PASS parent and child selected together move absolute position once without changing membership or relative coordinates',
    );

    await select('child-a');
    for (let i = 0; i < 4; i++) await key('Left', ['shift']);
    assert.equal((await position('child-a')).x, 0);
    const edge = await position('child-a');
    await key('Left', ['shift']);
    assert.deepEqual(await position('child-a'), edge);
    assert.equal(
      (await state()).current.nodes.find((item) => item.id === 'child-a')
        .groupId,
      'group',
    );
    await select('pinned');
    const pinned = await position('pinned');
    const pinnedDom = await rendered('pinned');
    await key('Right');
    await unchanged('pinned', pinned, pinnedDom);
    console.log(
      'PASS group member stays within its parent without detaching; pinned label cannot move',
    );

    await select('solo');
    await configure(
      'materialKeys.binding("moveLeft",null);materialKeys.binding("locateLabels",{key:"arrowleft",mod:false,shift:false,alt:false})',
    );
    await wait(
      'materialKeys.state().shortcuts.locateLabels.key==="arrowleft"',
      'label shortcut rebound',
    );
    const labelBefore = await position('solo');
    const labelDom = await rendered('solo');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Left' });
    await wait(
      '!!document.querySelector("nav[aria-label=标签位置]")',
      'node-focused custom arrow shows labels',
    );
    await configure('materialKeys.cloneBindings()');
    await sleep(40);
    assert.equal(
      await run('!!document.querySelector("nav[aria-label=标签位置]")'),
      true,
    );
    await unchanged('solo', labelBefore, labelDom);
    wc.sendInputEvent({
      type: 'keyDown',
      keyCode: 'Left',
      modifiers: ['isautorepeat'],
    });
    await sleep(40);
    assert.deepEqual(await run('materialInputEvents.at(-1)'), {
      key: 'ArrowLeft',
      repeat: true,
      trusted: true,
    });
    assert.equal(
      await run('document.querySelectorAll("nav[aria-label=标签位置]").length'),
      1,
    );
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Left' });
    await wait(
      '!document.querySelector("nav[aria-label=标签位置]")',
      'keyup hides labels',
    );
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Left' });
    await wait(
      '!!document.querySelector("nav[aria-label=标签位置]")',
      'new label hold',
    );
    await configure('materialKeys.binding("locateLabels",null)');
    await wait(
      '!document.querySelector("nav[aria-label=标签位置]")',
      'cleared binding immediately ends hold',
    );
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Left' });
    await configure(
      'materialKeys.binding("locateLabels",{key:"arrowleft",mod:false,shift:false,alt:false})',
    );
    await sleep(40);
    assert.equal(
      await run('!!document.querySelector("nav[aria-label=标签位置]")'),
      false,
    );
    await key('l');
    assert.equal(
      await run('!!document.querySelector("nav[aria-label=标签位置]")'),
      false,
    );
    await focus(`${node('solo')} textarea`);
    await run('document.activeElement.setSelectionRange(2,2)');
    await key('Left');
    assert.equal(await run('document.activeElement.selectionStart'), 1);
    assert.equal(
      await run('!!document.querySelector("nav[aria-label=标签位置]")'),
      false,
    );
    await focus(`${node('solo')} button[aria-label="移除文本卡片"]`);
    await key('Left');
    await unchanged('solo', labelBefore, labelDom);
    assert.equal(
      await run('!!document.querySelector("nav[aria-label=标签位置]")'),
      false,
    );
    await focus(node('solo'));
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Left' });
    await wait(
      '!!document.querySelector("nav[aria-label=标签位置]")',
      'labels shown before focus leaves',
    );
    await focus(`${node('solo')} textarea`);
    await wait(
      '!document.querySelector("nav[aria-label=标签位置]")',
      'text focus ends hold',
    );
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Left' });
    await configure('materialKeys.defaults()');
    console.log(
      'PASS custom label arrow works on focused nodes without movement; keyup, repeat, old key and nested controls preserve the hold boundary',
    );

    for (const labelKey of ['L', 'Left']) {
      if (labelKey === 'Left') {
        await configure(
          'materialKeys.binding("moveLeft",null);materialKeys.binding("locateLabels",{key:"arrowleft",mod:false,shift:false,alt:false})',
        );
        await wait(
          'materialKeys.state().shortcuts.locateLabels.key==="arrowleft"',
          'custom label key installed',
        );
      }
      await focus(node('solo'));
      // React Flow may pan an offscreen node into view on focus. Take the
      // comparison after that real focus update, before activating the marker.
      await painted();
      const beforeJump = (await state()).current;
      wc.sendInputEvent({ type: 'keyDown', keyCode: labelKey });
      await wait(
        '!!document.querySelector("nav[aria-label=标签位置]")',
        'held label markers visible',
      );
      const markerId = labelKey === 'L' ? 'pinned' : 'far';
      const marker = `nav[aria-label=标签位置] button[data-label-id=${markerId}]`;
      await focus(marker);
      await painted();
      assert.equal(
        await run('!!document.querySelector("nav[aria-label=标签位置]")'),
        true,
      );
      const point = await run(
        `(()=>{const r=document.querySelector(${JSON.stringify(marker)}).getBoundingClientRect();const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);return {x,y,hit:document.elementFromPoint(x,y)?.closest('[data-label-id]')?.dataset.labelId}})()`,
      );
      assert.equal(
        point.hit,
        markerId,
        'measured click point hits the visible marker',
      );
      const pointerStart = await run('materialPointerEvents.length');
      const coordinates = { x: point.x, y: point.y };
      wc.sendInputEvent({ type: 'mouseMove', ...coordinates });
      wc.sendInputEvent({
        type: 'mouseDown',
        button: 'left',
        clickCount: 1,
        ...coordinates,
      });
      await wait(
        `materialPointerEvents.slice(${pointerStart}).some(event=>event.type==='mousedown'&&event.label===${JSON.stringify(markerId)}&&event.trusted)`,
        'real mousedown delivered to held marker',
      );
      wc.sendInputEvent({
        type: 'mouseUp',
        button: 'left',
        clickCount: 1,
        ...coordinates,
      });
      await wait(
        `materialPointerEvents.slice(${pointerStart}).some(event=>event.type==='click'&&event.label===${JSON.stringify(markerId)}&&event.trusted)`,
        'real click delivered before releasing the locator key',
      );
      assert.deepEqual(
        await run(
          `materialPointerEvents.slice(${pointerStart}).filter(event=>event.label===${JSON.stringify(markerId)}).map(event=>({type:event.type,trusted:event.trusted}))`,
        ),
        [
          { type: 'mousedown', trusted: true },
          { type: 'mouseup', trusted: true },
          { type: 'click', trusted: true },
        ],
      );
      wc.sendInputEvent({ type: 'keyUp', keyCode: labelKey });
      await wait(
        '!document.querySelector("nav[aria-label=标签位置]")',
        'release hides marker after click',
      );
      await wait(
        `JSON.stringify(materialKeys.state().current.viewport)!==${JSON.stringify(JSON.stringify(beforeJump.viewport))}`,
        'real marker click changes camera',
      );
      assert.deepEqual((await state()).current.nodes, beforeJump.nodes);
      assert.equal(await run('materialKeys.flush()'), true);
      assert.deepEqual(
        (await state()).stored.shots[0].viewport,
        (await state()).current.viewport,
      );
    }
    console.log(
      'PASS default and custom held label markers survive focus and real pointer activation, jump the camera and save its viewport without moving nodes',
    );

    await run(
      `[...document.querySelector(${JSON.stringify(node('group'))}).querySelectorAll('button')].find(button=>button.textContent.trim()==='展开编辑').click()`,
    );
    await wait(
      '!!document.querySelector("dialog.group-stage[open] textarea")',
      'group editor opens',
    );
    const groupText = (await state()).current.nodes.find(
      (item) => item.id === 'child-a',
    ).text;
    await focus('dialog.group-stage textarea[aria-label="文本块 1"]');
    await run(
      'document.activeElement.setSelectionRange(document.activeElement.value.length,document.activeElement.value.length)',
    );
    wc.insertText('追加内容');
    await wait(
      'materialKeys.state().current.nodes.find(item=>item.id==="child-a").text.endsWith("追加内容")',
      'real group text edit',
    );
    await run(
      'document.querySelector("dialog.group-stage button[aria-label=撤销]").click()',
    );
    await wait(
      `materialKeys.state().current.nodes.find(item=>item.id==="child-a").text===${JSON.stringify(groupText)}`,
      'expanded group undo remains usable',
    );
    await run(
      'document.querySelector("dialog.group-stage button[aria-label=重做]").click()',
    );
    await wait(
      'materialKeys.state().current.nodes.find(item=>item.id==="child-a").text.endsWith("追加内容")',
      'expanded group redo remains usable',
    );
    const overlayPositions = (await state()).current.nodes.map(
      ({ id, position }) => ({ id, position }),
    );
    await focus('dialog.group-stage button[aria-label=撤销]');
    await key('Left');
    assert.equal(
      await run('!!document.querySelector("nav[aria-label=标签位置]")'),
      false,
    );
    assert.deepEqual(
      (await state()).current.nodes.map(({ id, position }) => ({
        id,
        position,
      })),
      overlayPositions,
    );
    await run(
      `[...document.querySelectorAll('dialog.group-stage button')].find(button=>button.textContent.trim()==='收起组合').click()`,
    );
    await wait(
      '!document.querySelector("dialog.group-stage")',
      'group editor closes',
    );
    console.log(
      'PASS expanded group text undo/redo buttons remain active while movement and held label shortcuts cannot reach the background',
    );

    assert.equal(await run('materialKeys.flush()'), true);
    const expected = (await state()).current;
    await run(
      `[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='返回主画布').click()`,
    );
    await wait(
      'materialKeys.state().active===null',
      'canvas closes after saving',
    );
    await run('materialKeys.reopen()');
    await wait(
      '!!document.querySelector(".react-flow__node[data-id=solo]")',
      'same shot reopens',
    );
    assert.deepEqual((await state()).current, expected);
    assert.deepEqual((await state()).stored.shots[0], expected);
    assert.equal((await state()).canUndo, true);
    await sleep(150);
    assert.deepEqual(errors, []);
    console.log(
      'PASS close/reopen preserves saved positions, text, group parameters and history; strict renderer console empty',
    );
  } catch (error) {
    failed = true;
    console.error(error);
    console.error('renderer errors', errors);
    console.error('fixture state', await state());
    console.error('native input', await run('materialInputEvents'));
    console.error('native pointer', await run('materialPointerEvents'));
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
