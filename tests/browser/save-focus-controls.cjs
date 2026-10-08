// Real MaterialCanvas and leave hooks, native keyboard/input events, isolated typed IPC.
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
  mkdtempSync(join(root, 'src/renderer/.save-focus-controls-'));
const profile =
  process.env.AFFLATUS_FIXTURE_PROFILE ??
  mkdtempSync(join(tmpdir(), 'afflatus-save-focus-controls-'));
app.setPath('userData', profile);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>保存焦点回归</title></head><body><div id="root"></div><script>window.focusInputs=[];window.addEventListener('keydown',event=>focusInputs.push({type:event.type,key:event.key,trusted:event.isTrusted}),true);window.addEventListener('input',event=>focusInputs.push({type:event.type,trusted:event.isTrusted}),true)</script><script type="module" src="/@fs/${root}/tests/browser/save-focus-controls.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const wc = win.webContents;
  const run = (source) => wc.executeJavaScript(source);
  const errors = [];
  const failures = [];
  wc.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const page = 'section[aria-label="焦点测试素材子画布"]';
  const back = `${page} > header > button`;
  const first = '.react-flow__node[data-id="first"] textarea';
  const second = '.react-flow__node[data-id="second"] textarea';
  const retry = '[data-save-retry]';
  const painted = () =>
    run(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
  const wait = async (source, label) => {
    for (let i = 0; i < 250; i++) {
      if (await run(source)) return;
      await sleep(20);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const load = async () => {
    await win.loadURL(`${origin}/${basename(scratch)}/index.html`);
    app.focus({ steal: true });
    win.focus();
    wc.focus();
    await wait(
      `typeof saveFocus!=="undefined"&&!!document.querySelector(${JSON.stringify(first)})`,
      'material editor ready',
    );
    await wait('document.hasFocus()', 'fixture window activated');
    await painted();
  };
  const focus = async (selector, range) => {
    win.focus();
    wc.focus();
    // Activating the native window is asynchronous on both desktop platforms.
    // Target the input only afterwards; never refocus after the tested action.
    await wait('document.hasFocus()', 'native window focus before target');
    await run(
      `(()=>{const target=document.querySelector(${JSON.stringify(selector)});target.focus({preventScroll:true});${range ? `target.setSelectionRange(${range[0]},${range[1]},${JSON.stringify(range[2])});` : ''}})()`,
    );
    await wait(
      `document.hasFocus()&&document.activeElement===document.querySelector(${JSON.stringify(selector)})`,
      `focus ${selector}`,
    );
  };
  const selection = (selector) =>
    run(
      `(()=>{const target=document.querySelector(${JSON.stringify(selector)});return {focused:document.activeElement===target,value:target.value,start:target.selectionStart,end:target.selectionEnd,direction:target.selectionDirection}})()`,
    );
  const assertFocus = async (selector) => {
    await painted();
    assert.equal(
      await run(
        `document.activeElement===document.querySelector(${JSON.stringify(selector)})`,
      ),
      true,
      `focus returns to ${selector}`,
    );
  };
  const assertSelection = async (selector, before) => {
    await assertFocus(selector);
    assert.deepEqual(await selection(selector), before);
  };
  const key = async (keyCode) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode });
    if (keyCode === 'Return' || keyCode === 'Space')
      wc.sendInputEvent({
        type: 'char',
        keyCode: keyCode === 'Return' ? '\r' : ' ',
      });
    wc.sendInputEvent({ type: 'keyUp', keyCode });
    await painted();
    const event = await run(
      'focusInputs.filter(item=>item.type==="keydown").at(-1)',
    );
    assert.equal(event?.trusted, true, 'native keydown reaches the page');
  };
  const type = async (selector, text) => {
    const before = await selection(selector);
    assert.equal(before.focused, true, 'continue typing without refocusing');
    await wc.insertText(text);
    const expected =
      before.value.slice(0, before.start) +
      text +
      before.value.slice(before.end);
    await wait(
      `document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(expected)}`,
      'native input accepted',
    );
    await wait(
      `saveFocus.state().current.nodes.some(node=>node.type==='text'&&node.text===${JSON.stringify(expected)})`,
      'React workspace accepts input',
    );
    assert.equal(
      await run(
        'focusInputs.filter(item=>item.type==="input").at(-1)?.trusted',
      ),
      true,
    );
  };
  const started = (id) =>
    wait(
      `saveFocus.state().gates.find(gate=>gate.id===${id})?.started`,
      `save ${id} started`,
    );
  const native = async () => {
    const ids = await run(
      '({gate:saveFocus.hold(),request:saveFocus.native()})',
    );
    await started(ids.gate);
    await wait(
      '!!document.querySelector("[data-save-before-leave]")&&document.activeElement===document.querySelector("[data-save-before-leave]")',
      'saving overlay owns focus',
    );
    return ids;
  };
  const localCapture = async () => {
    await focus(back);
    const gate = await run('saveFocus.holdCapture()');
    await key('Return');
    await started(gate);
    await wait(
      `document.querySelector(${JSON.stringify(page)}).inert`,
      'local close owns page inert',
    );
    return gate;
  };
  const globalCapture = async () => {
    const ids = await run(
      '({gate:saveFocus.holdCapture(),request:saveFocus.native()})',
    );
    await started(ids.gate);
    await wait(
      'saveFocus.state().saving&&!!document.querySelector("[data-save-before-leave]")',
      'global close owns save overlay',
    );
    return ids;
  };
  const assertPageFrozen = async () => {
    assert.equal(
      await run(`document.querySelector(${JSON.stringify(page)}).inert`),
      true,
      'one pending close still owns page inert',
    );
    await run(
      `document.querySelector(${JSON.stringify(first)}).focus({preventScroll:true})`,
    );
    assert.equal(
      await run(
        `document.activeElement===document.querySelector(${JSON.stringify(first)})`,
      ),
      false,
      'an inert page cannot receive editor focus',
    );
  };
  const release = async ({ gate, request }, saved) => {
    await run(`saveFocus.resolve(${gate},${saved})`);
    if (request)
      await wait(
        `saveFocus.state().results.some(result=>result.id===${request})`,
        'native result settled',
      );
    await wait('!saveFocus.state().saving', 'saving overlay released');
    await painted();
  };
  const scenario = async (name, operation) => {
    try {
      await load();
      await operation();
      assert.deepEqual(errors, []);
      console.log(`PASS ${name}`);
    } catch (error) {
      failures.push(error);
      console.error(`FAIL ${name}`, error);
      console.error(
        'focus diagnostic',
        await run(
          '({active:document.activeElement?.outerHTML.slice(0,700),activeLabel:document.activeElement?.getAttribute("aria-label"),activeText:document.activeElement?.textContent?.slice(0,100),hasFocus:document.hasFocus(),rootInert:document.getElementById("root")?.inert,dialogInert:document.querySelector("dialog")?.inert,pageInert:document.querySelector("[data-focus-scope]")?.inert,saveDialogEvents:window.saveDialogEvents,state:saveFocus.state(),events:focusInputs.slice(-8)})',
        ).catch(() => null),
      );
    }
  };
  try {
    await scenario(
      'keyboard return failure restores the re-enabled MaterialCanvas button and Tab continues inside the page',
      async () => {
        await focus(back);
        const gate = await run('saveFocus.hold()');
        await key('Return');
        await started(gate);
        assert.equal(
          await run(`document.querySelector(${JSON.stringify(back)}).disabled`),
          true,
        );
        assert.equal(
          await run(`document.querySelector(${JSON.stringify(page)}).inert`),
          true,
        );
        await run(`saveFocus.resolve(${gate},false)`);
        await wait(
          `!document.querySelector(${JSON.stringify(back)}).disabled&&!document.querySelector(${JSON.stringify(page)}).inert`,
          'return button enabled after failed save',
        );
        await assertFocus(back);
        await key('Tab');
        assert.equal(
          await run(
            `document.querySelector(${JSON.stringify(page)}).contains(document.activeElement)`,
          ),
          true,
        );
      },
    );
    await scenario(
      'native close failure restores the original textarea selection and accepts continued real input',
      async () => {
        await focus(first, [2, 6, 'backward']);
        const before = await selection(first);
        const attempt = await native();
        await release(attempt, false);
        assert.deepEqual(await run('saveFocus.state().results'), [
          { id: attempt.request, saved: false },
        ]);
        await assertSelection(first, before);
        await type(first, '恢复');
      },
    );
    await scenario(
      'explicit retry succeeds while staying on the page and restores the original textarea, not the retry button',
      async () => {
        await focus(first, [1, 4, 'forward']);
        const before = await selection(first);
        await release(await native(), false);
        const gate = await run('saveFocus.hold()');
        await focus(retry);
        await key('Return');
        await started(gate);
        await release({ gate }, true);
        assert.equal(await run('saveFocus.state().error'), null);
        assert.equal(await run('saveFocus.state().active'), 'shot');
        await assertSelection(first, before);
        await type(first, '继续');
      },
    );
    await scenario(
      'after a failed close, a deliberate new editor focus becomes the retry destination',
      async () => {
        await focus(first, [1, 3, 'forward']);
        await release(await native(), false);
        await focus(second, [1, 3, 'backward']);
        await type(second, '新');
        const before = await selection(second);
        const gate = await run('saveFocus.hold()');
        await focus(retry);
        await key('Return');
        await started(gate);
        await release({ gate }, true);
        await assertSelection(second, before);
        await type(second, '续');
      },
    );
    await scenario(
      'native timeout restores selection immediately; late completion cannot steal a newer editor focus',
      async () => {
        await focus(first, [2, 5, 'backward']);
        const before = await selection(first);
        const attempt = await native();
        await run('saveFocus.timeout()');
        await wait('!saveFocus.state().saving', 'timeout releases editing');
        await assertSelection(first, before);
        await type(first, '超时后');
        await focus(second, [0, 2, 'forward']);
        const newer = await selection(second);
        await release(attempt, true);
        assert.deepEqual(await run('saveFocus.state().results'), [
          { id: attempt.request, saved: false },
        ]);
        await assertSelection(second, newer);
      },
    );
    await scenario(
      'an old timed-out attempt cannot focus behind a newer save overlay',
      async () => {
        await focus(first, [0, 2, 'forward']);
        const old = await native();
        await run('saveFocus.timeout()');
        await wait('!saveFocus.state().saving', 'old timeout releases editing');
        await painted();
        await focus(second, [1, 4, 'backward']);
        const before = await selection(second);
        const fresh = await run(
          '({gate:saveFocus.hold(),request:saveFocus.native()})',
        );
        await wait(
          'saveFocus.state().saving&&document.activeElement===document.querySelector("[data-save-before-leave]")',
          'new overlay focused',
        );
        await run(`saveFocus.resolve(${old.gate},true)`);
        await started(fresh.gate);
        assert.equal(
          await run(
            'document.activeElement===document.querySelector("[data-save-before-leave]")',
          ),
          true,
        );
        await release(fresh, false);
        await assertSelection(second, before);
        assert.deepEqual(await run('saveFocus.state().results'), [
          { id: old.request, saved: false },
          { id: fresh.request, saved: false },
        ]);
      },
    );
    await scenario(
      'a removed text node falls back to the still-mounted material page after failure',
      async () => {
        await focus(first, [0, 2, 'forward']);
        const attempt = await native();
        await run('saveFocus.remove("first")');
        await wait(
          `!document.querySelector(${JSON.stringify(first)})`,
          'original editor removed by React',
        );
        await release(attempt, false);
        await assertFocus(page);
        await key('Tab');
        assert.equal(
          await run(
            `document.querySelector(${JSON.stringify(page)}).contains(document.activeElement)`,
          ),
          true,
        );
      },
    );
    await scenario(
      'a page-only save failure does not steal focus from another live surface',
      async () => {
        await run('saveFocus.outside(true)');
        await painted();
        await focus(back);
        const gate = await run('saveFocus.hold()');
        await key('Return');
        await started(gate);
        await focus('#other-surface');
        await run(`saveFocus.resolve(${gate},false)`);
        await wait(
          `!document.querySelector(${JSON.stringify(back)}).disabled&&!document.querySelector(${JSON.stringify(page)}).inert`,
          'material return released',
        );
        await assertFocus('#other-surface');
      },
    );
    await scenario(
      'local failure cannot release page inert while an overlapping native close still awaits its captured save',
      async () => {
        const local = await localCapture();
        const global = await globalCapture();
        await run(`saveFocus.resolve(${local},false)`);
        await wait(
          `!document.querySelector(${JSON.stringify(back)}).disabled`,
          'local failure releases its button',
        );
        assert.equal(await run('saveFocus.state().saving'), true);
        await assertPageFrozen();
        await assertFocus('[data-save-before-leave]');
        await release(global, false);
        assert.equal(
          await run(`document.querySelector(${JSON.stringify(page)}).inert`),
          false,
        );
        assert.equal(await run('document.getElementById("root").inert'), true);
        await assertFocus(back);
        await key('Tab');
        assert.equal(
          await run(
            `document.querySelector(${JSON.stringify(page)}).contains(document.activeElement)`,
          ),
          true,
        );
      },
    );
    await scenario(
      'native failure cannot release local page inert; the final local failure restores editing',
      async () => {
        const local = await localCapture();
        const global = await globalCapture();
        await release(global, false);
        assert.equal(
          await run(`document.querySelector(${JSON.stringify(back)}).disabled`),
          true,
        );
        await assertPageFrozen();
        await run(`saveFocus.resolve(${local},false)`);
        await wait(
          `!document.querySelector(${JSON.stringify(back)}).disabled&&!document.querySelector(${JSON.stringify(page)}).inert`,
          'last page close releases editing',
        );
        await assertFocus(back);
        await focus(first, [1, 4, 'backward']);
        await type(first, '继续');
      },
    );
    await scenario(
      'successful local close unmounts its page without unlocking an overlapping native save, which later restores the root',
      async () => {
        const local = await localCapture();
        const global = await globalCapture();
        await run(`saveFocus.resolve(${local},true)`);
        await wait(
          `!document.querySelector(${JSON.stringify(page)})&&saveFocus.state().active===null`,
          'saved material page unmounted',
        );
        assert.equal(await run('saveFocus.state().saving'), true);
        assert.equal(await run('document.getElementById("root").inert'), true);
        await run('document.getElementById("root-home").focus()');
        assert.equal(
          await run(
            'document.activeElement===document.getElementById("root-home")',
          ),
          false,
        );
        await release(global, false);
        assert.equal(await run('document.getElementById("root").inert'), false);
        await focus('#root-home');
        await key('Tab');
        assert.equal(
          await run('document.activeElement===document.body'),
          false,
        );
      },
    );
    await scenario(
      'two immediate native save failures preserve selection even when React batches saving false to false',
      async () => {
        await focus(first, [2, 6, 'backward']);
        const before = await selection(first);
        const outcome = await run(
          '(async()=>{saveFocus.holdFastFailure();const first=await saveFocus.nativeAndWait();saveFocus.holdFastFailure();const second=await saveFocus.nativeAndWait();return [first,second]})()',
        );
        assert.deepEqual(outcome, [
          { id: 1, saved: false },
          { id: 2, saved: false },
        ]);
        assert.equal(await run('saveFocus.state().saving'), false);
        await assertSelection(first, before);
        await type(first, '两次失败后');
      },
    );
    await scenario(
      'native modal input cannot escape a global save freeze and regains its exact selection after failure',
      async () => {
        await run('saveFocus.modal(true)');
        await wait(
          '!!document.querySelector("dialog[open] #modal-input")',
          'native Modal shown',
        );
        assert.equal(
          await run(
            'document.getElementById("modal-input").closest("dialog").matches(":modal")',
          ),
          true,
        );
        // showModal escapes its already-inert root. This input is genuinely
        // focusable before the save, so the freeze must cover the dialog itself.
        assert.equal(await run('document.getElementById("root").inert'), true);
        await focus('#modal-input', [2, 7, 'backward']);
        const before = await selection('#modal-input');
        const global = await globalCapture();
        assert.equal(
          await run(
            'document.querySelector("[data-save-before-leave]").matches(":modal")',
          ),
          true,
          'The actual save dialog owns the native top layer before Escape',
        );
        await run(
          `(()=>{const dialog=document.querySelector('[data-save-before-leave]');window.saveDialogBeforeEscape=dialog;window.saveDialogEvents=[];for(const type of ['cancel','close'])dialog.addEventListener(type,event=>queueMicrotask(()=>{saveDialogEvents.push({type:event.type,trusted:event.isTrusted,cancelable:event.cancelable,prevented:event.defaultPrevented,open:dialog.open,modal:dialog.matches(':modal'),same:dialog===document.querySelector('[data-save-before-leave]')});if(type==='cancel')window.saveCancel={trusted:event.isTrusted,prevented:event.defaultPrevented}}),{once:true})})()`,
        );
        await key('Escape');
        assert.equal(
          await run(
            'focusInputs.filter(item=>item.type==="keydown").at(-1)?.key',
          ),
          'Escape',
        );
        assert.equal(await run('saveFocus.state().saving'), true);
        assert.equal(
          await run(
            'document.querySelector("[data-save-before-leave]")===window.saveDialogBeforeEscape&&saveDialogBeforeEscape.open&&saveDialogBeforeEscape.matches(":modal")',
          ),
          true,
        );
        assert.equal(
          await run(
            'window.saveDialogEvents.some(event=>event.type==="close")',
          ),
          false,
          'Escape never temporarily closes the in-flight save dialog',
        );
        assert.equal(
          await run(
            'document.getElementById("modal-input").closest("dialog").matches(":modal")',
          ),
          true,
          'Escape must not dismiss the underlying editing Modal',
        );
        assert.deepEqual(await run('saveFocus.state().results'), []);
        await run(
          'document.getElementById("modal-input").focus({preventScroll:true})',
        );
        assert.equal(
          await run(
            'document.activeElement===document.getElementById("modal-input")',
          ),
          false,
          'top-layer dialog must not bypass the global save lock',
        );
        await wc.insertText('不应进入');
        await painted();
        assert.equal(await run('saveFocus.state().modalText'), before.value);
        assert.equal(
          await run('document.getElementById("modal-input").value'),
          before.value,
        );
        await release(global, false);
        await assertSelection('#modal-input', before);
        await wait(
          `document.querySelector(${JSON.stringify(retry)})?.closest('dialog')===document.getElementById('modal-input').closest('dialog')`,
          'save failure is visibly hosted in its original Modal',
        );
        await painted();
        const screenshot = join(
          tmpdir(),
          'afflatus-save-focus-modal-failure.png',
        );
        writeFileSync(screenshot, (await wc.capturePage()).toPNG());
        console.log(`SCREENSHOT ${screenshot}`);
        const retryGate = await run('saveFocus.hold()');
        await focus(retry);
        await key('Return');
        await started(retryGate);
        await release({ gate: retryGate }, true);
        assert.equal(await run('saveFocus.state().error'), null);
        await assertSelection('#modal-input', before);
        await wc.insertText('恢复输入');
        const expected =
          before.value.slice(0, before.start) +
          '恢复输入' +
          before.value.slice(before.end);
        await wait(
          `saveFocus.state().modalText===${JSON.stringify(expected)}`,
          'Modal React input continues after save failure',
        );
        assert.equal(
          await run(
            'focusInputs.filter(item=>item.type==="input").at(-1)?.trusted',
          ),
          true,
        );
        assert.equal(
          await run(
            'document.getElementById("modal-input").closest("dialog").matches(":modal")',
          ),
          true,
        );
        await release(await globalCapture(), false);
        assert.equal(
          await run(
            `document.querySelector(${JSON.stringify(retry)}).closest('dialog')===document.getElementById('modal-input').closest('dialog')`,
          ),
          true,
          'A retained save error is actionable inside its original modal',
        );
        await focus('dialog:has(#modal-input) button[aria-label="关闭"]');
        await key('Return');
        await wait(
          '!document.getElementById("modal-input")',
          'original Modal closed through its real button',
        );
        await wait(
          `document.querySelector(${JSON.stringify(retry)})?.closest('[role="alert"]')?.parentElement===document.body`,
          'the same retained error returns to the body when its modal unregisters',
        );
        const bodyRetry = await run('saveFocus.hold()');
        await focus(retry);
        await key('Return');
        await started(bodyRetry);
        await release({ gate: bodyRetry }, true);
        assert.equal(await run('saveFocus.state().error'), null);
        assert.equal(
          await run('!!document.querySelector("[data-save-retry]")'),
          false,
        );
      },
    );
    await scenario(
      'native Escape respects the same Modal async guard, repeated checks, and child cancellation before controlled close',
      async () => {
        await run('saveFocus.guardedModal()');
        await wait(
          '!!document.querySelector("dialog[open] #modal-input")',
          'guarded native Modal shown',
        );
        await focus('#modal-input');
        await run(
          'window.guardedDialog=document.getElementById("modal-input").closest("dialog")',
        );
        const assertSameModal = async () => {
          assert.equal(
            await run(
              'window.guardedDialog===document.getElementById("modal-input")?.closest("dialog")&&guardedDialog.open&&guardedDialog.matches(":modal")',
            ),
            true,
            'native Escape cannot bypass a pending or rejected close guard',
          );
        };
        for (let attempt = 0; attempt < 2; attempt++) {
          const gate = await run('saveFocus.holdModal()');
          await key('Escape');
          await started(gate);
          await assertSameModal();
          if (attempt === 0) {
            await key('Escape');
            await assertSameModal();
            assert.equal(
              await run(
                'saveFocus.state().gates.filter(gate=>gate.phase==="modal"&&gate.started).length',
              ),
              1,
              'a second Escape during the same check never starts another check',
            );
          }
          await run(`saveFocus.resolve(${gate},false)`);
          await painted();
          await assertSameModal();
        }
        const allowed = await run('saveFocus.holdModal()');
        await run('saveFocus.preventModalEscape(true)');
        await focus('#modal-input');
        await key('Escape');
        await assertSameModal();
        assert.equal(
          await run(
            `saveFocus.state().gates.find(gate=>gate.id===${allowed}).started`,
          ),
          false,
          'a child control can consume Escape without invoking the Modal guard',
        );
        await run('saveFocus.preventModalEscape(false)');
        await key('Escape');
        await started(allowed);
        await assertSameModal();
        await run(`saveFocus.resolve(${allowed},true)`);
        await wait(
          '!document.getElementById("modal-input")',
          'allowed Escape uses the normal animated Modal close',
        );
        assert.equal(await run('window.guardedDialog.isConnected'), false);
      },
    );
    assert.deepEqual(errors, [], 'renderer console remains clean');
  } catch (error) {
    failures.push(error);
    console.error(error);
  } finally {
    win.destroy();
    try {
      if (!process.env.AFFLATUS_FIXTURE_SCRATCH)
        rmSync(scratch, { recursive: true, force: true });
      if (!process.env.AFFLATUS_FIXTURE_PROFILE)
        rmSync(profile, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
      console.error(error);
    }
    app.exit(failures.length ? 1 : 0);
  }
});
