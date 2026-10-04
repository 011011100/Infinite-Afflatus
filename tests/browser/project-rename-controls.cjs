// Actual StrictMode React/name/Modal lifecycle with deliberately delayed typed IPC.
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
  mkdtempSync(join(root, 'src/renderer/.project-rename-controls-'));
const profile =
  process.env.AFFLATUS_FIXTURE_PROFILE ??
  mkdtempSync(join(tmpdir(), 'afflatus-rename-controls-'));
app.setPath('userData', profile);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>名称恢复回归</title></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/project-rename-controls.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 800,
    webPreferences: { backgroundThrottling: false, offscreen: true },
  });
  const run = (source) => win.webContents.executeJavaScript(source);
  const errors = [];
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const button = (label) =>
    `[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')??b.textContent.trim())===${JSON.stringify(label)})`;
  const click = (label) => run(`${button(label)}.click()`);
  const state = () => run('nameControls.state()');
  const wait = async (condition, label) => {
    for (let n = 0; n < 250; n++) {
      if (await run(condition)) return;
      await sleep(20);
    }
    throw new Error(`Timeout: ${label}`);
  };
  const load = async () => {
    await win.loadURL(`${origin}/${basename(scratch)}/index.html`);
    await wait(
      'typeof nameControls!=="undefined" && !!document.querySelector("h1")',
      'mounted',
    );
  };
  const open = async () => {
    await click('修改项目名称');
    await wait('!!document.querySelector("dialog[open]")', 'opened');
  };
  let failed = false;
  try {
    await load();
    await open();
    await run('nameControls.input("新名称");nameControls.refresh()');
    assert.equal(await run('document.querySelector("input").value'), '新名称');
    assert.equal((await state()).protections.length, 1);
    assert.equal((await state()).recoveries.length, 0);
    await click('保存');
    await wait('document.querySelector("input").readOnly', 'save frozen');
    await click('关闭');
    await run('nameControls.input("不能覆盖")');
    assert.equal((await state()).editor.target, '新名称');
    await run('nameControls.protect()');
    await wait(
      'nameControls.state().recoveries.length===1',
      'checkpoint before native commit',
    );
    await run('nameControls.recover()');
    await wait('!document.querySelector("dialog")', 'successful close');
    assert.equal((await state()).saved.project.name, '新名称');
    assert.equal((await state()).refreshes, 1);
    console.log(
      'PASS StrictMode input survives refresh; explicit save waits protection and freezes edits/close until native success',
    );

    await load();
    await open();
    await run('nameControls.input("待取消")');
    await click('取消');
    assert.equal((await state()).discards.length, 0);
    assert.equal(await run('document.querySelector("dialog").inert'), false);
    await run('nameControls.protect()');
    await wait(
      'nameControls.state().discards.length===1',
      'discard waits checkpoint',
    );
    await run('nameControls.discard(false)');
    await wait(
      'document.body.innerText.includes("未取消修改")',
      'failed cleanup retained',
    );
    assert.equal(await run('document.querySelector("dialog").inert'), false);
    await run('nameControls.input("失败后仍能编辑")');
    await wait(
      'document.querySelector("input").value === "失败后仍能编辑"',
      'failed close leaves editing available',
    );
    await run('nameControls.protect()');
    await click('取消');
    await wait('nameControls.state().discards.length===2', 'explicit retry');
    await run('nameControls.discard()');
    await wait('!document.querySelector("dialog")', 'cleanup confirmed close');
    assert.equal((await state()).stored, null);
    console.log(
      'PASS async Modal close stays interactive on exact cleanup failure and closes only after retry succeeds',
    );

    await load();
    await run('nameControls.restore()');
    await wait('!!document.querySelector("dialog[open]")', 'restored input');
    assert.equal(
      await run('document.querySelector("input").value'),
      '恢复的输入',
    );
    assert.equal((await state()).recoveries.length, 0);
    assert.match(
      await run('document.body.innerText'),
      /点击保存后才会修改项目名称/,
    );
    await run('nameControls.input("恢复后继续修改")');
    assert.equal((await state()).editor.sessionId, 'restore-session');
    assert.equal((await state()).editor.key.seq, 10);
    await run('nameControls.protect()');
    await click('保存');
    await wait(
      'nameControls.state().recoveries.length===1',
      'explicit restored save',
    );
    await run('nameControls.recover(true)');
    await wait(
      'document.body.innerText.includes("项目名称已变化")',
      'native conflict',
    );
    assert.equal(await run('nameControls.flush()'), false);
    assert.ok((await state()).stored);
    await click('导出名称恢复文件');
    await wait('nameControls.state().exports.length===1', 'rescue export');
    console.log(
      'PASS recovered name remains input until explicit save; conflict keeps input/recovery and supports rescue export',
    );

    await load();
    await open();
    assert.equal(await run('nameControls.flush()'), true);
    assert.equal((await state()).protections.length, 0);
    await run(
      'nameControls.input("离开取消后继续修改");nameControls.protect()',
    );
    assert.equal(await run('document.querySelector("input").readOnly'), false);
    assert.equal((await state()).editor.target, '离开取消后继续修改');
    assert.equal(await run('nameControls.flush()'), false);
    await load();
    await open();
    await run('nameControls.input("未提交");nameControls.protect()');
    assert.equal(await run('nameControls.flush()'), false);
    assert.equal((await state()).saved.project.name, '原名称');
    await run('nameControls.block(true)');
    await wait(
      'document.querySelector("input").readOnly',
      'unavailable freezes',
    );
    assert.match(await run('document.body.innerText'), /项目暂时不可用/);
    assert.equal(await run(`${button('保存')}.disabled`), true);
    console.log(
      'PASS no-op input allows leave, changed input blocks leave, unavailable notice retains the draft and freezes editing',
    );

    await load();
    await open();
    await run(
      'nameControls.input("已保存待刷新");nameControls.protect();nameControls.failRefresh(true)',
    );
    await click('保存');
    await wait(
      'nameControls.state().recoveries.length === 1',
      'native pending',
    );
    await run('nameControls.recover()');
    await wait(
      'document.body.innerText.includes("刷新暂时失败")',
      'presentation error',
    );
    assert.equal(await run('document.querySelector("dialog").inert'), false);
    assert.equal((await state()).stored, null);
    assert.equal((await state()).saved.project.name, '已保存待刷新');
    await run('nameControls.failRefresh(false)');
    await click('重试更新项目');
    await wait(
      '!document.querySelector("dialog")',
      'presentation retry closed',
    );
    assert.equal((await state()).recoveries.length, 1);
    assert.equal((await state()).refreshes, 2);
    console.log(
      'PASS native success with failed presentation keeps the modal; retry refreshes without committing the name twice',
    );

    await load();
    await open();
    await run('nameControls.input("A");nameControls.protect()');
    await click('保存');
    await wait('nameControls.state().recoveries.length===1', 'A submitted');
    await run('nameControls.recover(false,true)');
    await wait(
      'document.body.innerText.includes("保存回执丢失")',
      'A reply lost',
    );
    await run(
      'nameControls.input("B");nameControls.protect();nameControls.failRead(true)',
    );
    await click('保存');
    await wait(
      'document.body.innerText.includes("项目读取暂不可用")',
      'offline preflight',
    );
    assert.equal((await state()).recoveries.length, 1);
    assert.equal((await state()).protections.length, 2);
    assert.equal(await run('document.querySelector("input").value'), 'B');
    assert.equal(await run('document.querySelector("input").readOnly'), false);
    await run('nameControls.failRead(false)');
    await click('保存');
    await wait(
      'nameControls.state().protections.length===3',
      'A baseline checkpoint before B',
    );
    assert.equal((await state()).recoveries.length, 1);
    assert.equal((await state()).protections[2].baseline, 'A');
    await run('nameControls.protect()');
    await wait(
      'nameControls.state().recoveries.length===2',
      'B submitted after protection',
    );
    await run('nameControls.recover(false,true)');
    await wait(
      'document.body.innerText.includes("保存回执丢失")',
      'B reply lost',
    );
    await run('nameControls.input("C");nameControls.protect()');
    assert.equal((await state()).protections.at(-1).baseline, 'A');
    assert.equal((await state()).protections.at(-1).lastSubmitted, 'B');
    await click('保存');
    await wait(
      'nameControls.state().protections.length===5',
      'B baseline checkpoint before C',
    );
    await run('nameControls.protect()');
    await wait('nameControls.state().recoveries.length===3', 'C submission');
    await run('nameControls.recover()');
    await wait('!document.querySelector("dialog")', 'C saved');
    assert.equal((await state()).saved.project.name, 'C');
    console.log(
      'PASS consecutive real commits with lost replies require authoritative preflight; offline retry preserves input and C remains recoverable',
    );

    await load();
    await run('nameControls.recovering(true)');
    assert.equal(await run('nameControls.open()'), false);
    await run('nameControls.recovering(false)');
    await open();
    await run('nameControls.input("正在保存");nameControls.protect()');
    await click('保存');
    await wait(
      'nameControls.state().recoveries.length===1',
      'pending native recovery',
    );
    await run('nameControls.show(false)');
    await wait('!document.querySelector("dialog")', 'unmounted');
    await run('nameControls.recover()');
    assert.equal((await state()).refreshes, 0);
    await run('nameControls.show(true)');
    await wait('!!document.querySelector("h1")', 'new editor mount');
    await open();
    assert.equal((await state()).editor.target, '正在保存');
    assert.equal((await state()).refreshes, 0);
    console.log(
      'PASS another recovery blocks opening; late native save after unmount never refreshes/closes the new editor',
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    failed = true;
    console.error(error);
    console.error(errors);
    console.error(await run('document.body.innerText'));
  } finally {
    win.destroy();
    try {
      if (!process.env.AFFLATUS_FIXTURE_SCRATCH)
        rmSync(scratch, { recursive: true, force: true });
      if (!process.env.AFFLATUS_FIXTURE_PROFILE)
        rmSync(profile, { recursive: true, force: true });
    } catch (error) {
      failed = true;
      console.error(error);
    } finally {
      app.exit(failed ? 1 : 0);
    }
  }
});
