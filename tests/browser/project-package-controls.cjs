// Real React package/home/lifecycle components with delayed typed native replies.
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
  mkdtempSync(join(root, 'src/renderer/.package-controls-'));
const profile =
  process.env.AFFLATUS_FIXTURE_PROFILE ??
  mkdtempSync(join(tmpdir(), 'afflatus-package-controls-'));
app.setPath('userData', profile);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>项目包进度回归</title></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/project-package-controls.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 850,
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
  const state = () => run('packageControls.state()');
  const body = () => run('document.body.innerText');
  const status = 'document.querySelector("section[aria-label=项目包进度]")';
  const wait = async (condition, label) => {
    for (let n = 0; n < 250; n++) {
      if (await run(condition)) return;
      await sleep(20);
    }
    throw new Error(`Timeout: ${label}`);
  };
  const reset = async () => {
    await win.loadURL(`${origin}/${basename(scratch)}/index.html`);
    await wait(`!!${button('导入项目包')}`, 'home loaded');
  };
  const openProject = async () => {
    await run('document.querySelector("ul button").click()');
    await wait(`!!${button('项目备份')}`, 'project loaded');
  };
  const inspect = async () => {
    await click('项目备份');
    await wait(
      'packageControls.state().requests.at(-1)?.kind === "inspect"',
      'inspect started',
    );
    const index = (await state()).requests.length - 1;
    await run(`packageControls.finish(${index})`);
    await wait(
      `!!${button('导出项目包')} && !${button('导出项目包')}.disabled`,
      'inspection complete',
    );
  };
  let failed = false;
  try {
    await reset();
    await run(`{ const b=${button('导入项目包')}; b.click(); b.click(); }`);
    await wait('packageControls.state().requests.length===1', 'one import');
    await run(
      'packageControls.progress(0,{completedBytes:524288,totalBytes:1048576}); packageControls.holdCancellation(true)',
    );
    assert.match(await body(), /已写入 512.0 KB \/ 1.0 MB/);
    assert.equal(await run('document.querySelector("progress").value'), 524288);
    await click('取消项目包操作');
    await wait(
      `!!${button('正在停止…')} && ${button('正在停止…')}.disabled`,
      'stopping retains busy',
    );
    assert.equal(await run(`${button('导入项目包')}.disabled`), true);
    assert.equal((await state()).requests[0].done, false);
    await run('packageControls.finish(0,"cancel")');
    await wait(`!${button('导入项目包')}.disabled`, 'cleanup settled');
    assert.match(await body(), /项目包操作已取消/);
    assert.equal(await run('document.querySelector("[role=alert]")'), null);
    assert.equal((await state()).savedText, '');
    console.log(
      'PASS import reports real bytes; duplicate clicks start once; cancellation stays stopping until cleanup settles',
    );

    await run('packageControls.holdCancellation(false)');
    await click('导入项目包');
    await wait('packageControls.state().requests.length===2', 'retry import');
    await run(
      'packageControls.progress(1,{fileName:"新包.mp4"}); packageControls.progress(0,{fileName:"旧包迟到.mp4"})',
    );
    assert.match(await body(), /新包.mp4/);
    assert.doesNotMatch(await body(), /旧包迟到/);
    await run('packageControls.finish(1)');
    await wait(
      'document.querySelector("[data-project]").textContent==="独立新项目"',
      'import opens new project',
    );
    console.log(
      'PASS cancelled request progress cannot replace retry; successful import activates the independent new project',
    );

    await reset();
    await openProject();
    await run('packageControls.holdFlush()');
    await click('项目备份');
    await wait(
      `${status}?.textContent.includes('正在保存当前修改')`,
      'save before native start',
    );
    assert.equal((await state()).requests.length, 0);
    await click('取消项目包操作');
    await run('packageControls.resolveFlush()');
    await wait(
      `${status}?.textContent.includes('操作已取消')`,
      'local cancellation',
    );
    assert.equal((await state()).requests.length, 0);
    assert.equal((await state()).savedText, '未保存的创作');
    console.log(
      'PASS cancelling while existing edits flush prevents a late native request and preserves the saved edit',
    );

    await click('关闭');
    await wait('!document.querySelector("dialog")', 'inspection modal closed');
    await inspect();
    await click('导出项目包');
    await wait('packageControls.state().requests.length===2', 'export chooser');
    await run(
      'packageControls.progress(1,{completedBytes:1048576,phase:"finalizing",canCancel:false})',
    );
    assert.match(await body(), /正在完成项目包/);
    assert.doesNotMatch(await body(), /项目包已保存/);
    assert.equal(await run(`${button('取消项目包操作')}.disabled`), true);
    await click('关闭');
    await wait('!document.querySelector("dialog")', 'hide progress');
    await click('正在处理项目包');
    await wait('!!document.querySelector("dialog[open]")', 'reopen progress');
    assert.equal((await state()).requests.length, 2);
    await run('packageControls.finish(1)');
    await wait(
      `${status}?.textContent.includes('项目包已保存')`,
      'export publication',
    );
    writeFileSync(
      join(tmpdir(), 'afflatus-project-package-controls.png'),
      (await win.webContents.capturePage()).toPNG(),
    );
    console.log(
      'PASS finalizing is not success; hiding and reopening the existing modal retains the same package task',
    );

    await click('创建副本');
    await wait('packageControls.state().requests.length===3', 'duplicate');
    await run('packageControls.holdCancellation(true)');
    await click('取消项目包操作');
    await run('packageControls.finish(2)');
    await wait(
      `${status}?.textContent.includes('已创建「独立新项目」')`,
      'published copy survives late cancel',
    );
    assert.doesNotMatch(await body(), /操作已取消/);
    await click('导出项目包');
    await wait(
      'packageControls.state().requests.length===4',
      'cleanup failure export',
    );
    await click('取消项目包操作');
    await run('packageControls.finish(3,"error")');
    await wait(
      'document.querySelector("[role=alert]")?.textContent.includes("临时文件清理失败")',
      'cleanup error visible',
    );
    assert.doesNotMatch(await body(), /操作已取消/);
    console.log(
      'PASS published results win late cancellation; cleanup failures remain actionable errors',
    );

    await reset();
    await openProject();
    await inspect();
    await click('导出项目包');
    await wait('packageControls.state().requests.length===2', 'export started');
    await click('关闭');
    await wait(
      '!document.querySelector("dialog")',
      'modal hidden for navigation',
    );
    await run(
      'packageControls.edit("返回前的新文字"); packageControls.holdCancellation(true)',
    );
    await click('返回首页');
    await wait(
      'packageControls.state().pauses.length===1',
      'leave native pause',
    );
    assert.equal((await state()).homeResults.length, 0);
    await run('packageControls.finish(1,"cancel")');
    await wait(
      'document.querySelector("[data-project]").textContent==="首页"',
      'home after stop/save',
    );
    assert.equal((await state()).savedText, '返回前的新文字');
    assert.equal((await state()).pauses.length, 0);
    const events = (await state()).events;
    assert.ok(
      events.findIndex(
        (event) => event.startsWith('finish:') && event.endsWith(':cancel'),
      ) < events.lastIndexOf('flush:返回前的新文字'),
    );
    console.log(
      'PASS returning home waits for package cleanup before saving new edits and releases its own pause',
    );

    await reset();
    await openProject();
    await inspect();
    await click('导出项目包');
    await wait(
      'packageControls.state().requests.length===2',
      'material export',
    );
    await click('关闭');
    await wait(
      '!document.querySelector("dialog")',
      'backup hidden before material',
    );
    await run(
      'packageControls.material(true); packageControls.edit("素材页面离开前的文字"); packageControls.holdCancellation(true)',
    );
    await wait(`!!${button('返回主画布')}`, 'material canvas open');
    await click('返回主画布');
    await wait(
      'packageControls.state().pauses.length===1',
      'material package pause',
    );
    assert.equal((await state()).events.includes('material:closed'), false);
    assert.equal((await state()).requests[1].done, false);
    await run('packageControls.finish(1,"cancel")');
    await wait(
      `!${button('返回主画布')}`,
      'material closes after package stop',
    );
    const materialState = await state();
    assert.equal(materialState.savedText, '素材页面离开前的文字');
    assert.equal(materialState.pauses.length, 0);
    assert.equal(materialState.referencePauses.length, 0);
    assert.ok(
      materialState.events.findIndex((event) => event.endsWith(':cancel')) <
        materialState.events.lastIndexOf('flush:素材页面离开前的文字'),
    );
    assert.ok(
      materialState.events.lastIndexOf('flush:素材页面离开前的文字') <
        materialState.events.indexOf('material:closed'),
    );
    console.log(
      'PASS real material-canvas return stops background package work before flushing and releases both independent pauses',
    );

    await reset();
    await openProject();
    await run('packageControls.holdFlush()');
    await click('项目备份');
    await wait(
      `${status}?.textContent.includes('正在保存当前修改')`,
      'pending initial save',
    );
    await run(
      'packageControls.nativeClose(); packageControls.failFlush(true); packageControls.resolveFlush()',
    );
    await wait(
      'packageControls.state().closeResults.length===1',
      'failed native leave',
    );
    assert.deepEqual((await state()).closeResults, [false]);
    assert.equal((await state()).requests.length, 0);
    assert.equal((await state()).pauses.length, 0);
    assert.equal(
      await run('document.querySelector("textarea").closest("[inert]")'),
      null,
    );
    await run('packageControls.failFlush(false)');
    await click('关闭');
    await wait(
      '!document.querySelector("dialog")',
      'failed leave still usable',
    );
    await inspect();
    console.log(
      'PASS native leave cancels a renderer-only pending request; failed saves retain editable page and allow a new task',
    );

    await reset();
    await run('packageControls.holdPause(true); packageControls.nativeClose()');
    await wait(
      'packageControls.state().pauses.length===1',
      'old pause waiting',
    );
    await run(
      'packageControls.timeout(); packageControls.edit("超时后编辑"); packageControls.nativeClose()',
    );
    await wait(
      'packageControls.state().pauses.length===2',
      'new independent pause',
    );
    const tokens = (await state()).pauses;
    await run('packageControls.releasePause(0)');
    await wait(
      'packageControls.state().released.length===1',
      'old late lease released',
    );
    assert.deepEqual((await state()).released, [tokens[0]]);
    assert.deepEqual((await state()).pauses, [tokens[1]]);
    assert.notEqual(
      await run('document.querySelector("textarea").closest("[inert]")'),
      null,
    );
    await run('packageControls.releasePause(1)');
    await wait(
      'packageControls.state().closeResults.length===2',
      'new native close',
    );
    assert.deepEqual((await state()).closeResults, [false, true]);
    assert.equal((await state()).savedText, '超时后编辑');
    assert.deepEqual((await state()).pauses, [tokens[1]]);
    await run('packageControls.timeout()');
    await wait(
      'packageControls.state().pauses.length===0',
      'cancelled native close releases own lease',
    );
    console.log(
      'PASS a timed-out leave releases only its late token; a newer close re-saves current input and stays frozen until cancelled',
    );

    await reset();
    await openProject();
    await inspect();
    await click('导出项目包');
    await wait('packageControls.state().requests.length===2', 'unmount export');
    await run('packageControls.show(false)');
    await wait(
      'packageControls.state().requests[1].done',
      'unmounted task stops',
    );
    await run('packageControls.show(true)');
    await wait(`!!${button('项目备份')}`, 'replacement mounted');
    await click('项目备份');
    await wait(
      'packageControls.state().requests.length===3',
      'replacement inspect',
    );
    await run(
      'packageControls.progress(2,{fileName:"当前检查.mp4"}); packageControls.progress(1,{fileName:"已卸载旧任务.mp4"})',
    );
    assert.match(await body(), /当前检查.mp4/);
    assert.doesNotMatch(await body(), /已卸载旧任务/);
    assert.equal((await state()).listeners, 2);
    await run('packageControls.finish(2)');
    console.log(
      'PASS StrictMode/unmount release only the owned request and subscription; old events cannot replace a new modal',
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    failed = true;
    console.error(error);
    console.error(errors);
    console.error(await body());
    console.error(await state());
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
