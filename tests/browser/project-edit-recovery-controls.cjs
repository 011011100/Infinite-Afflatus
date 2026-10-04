// Common recovery notice/hook integration; typed native calls are deliberately delayed.
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
  mkdtempSync(join(root, 'src/renderer/.project-edit-recovery-controls-'));
const profile =
  process.env.AFFLATUS_FIXTURE_PROFILE ??
  mkdtempSync(join(tmpdir(), 'afflatus-edit-recovery-controls-'));
app.setPath('userData', profile);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>编辑恢复回归</title></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/project-edit-recovery-controls.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1050,
    height: 900,
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
  const state = () => run('editControls.state()');
  const wait = async (condition, label) => {
    for (let n = 0; n < 250; n++) {
      if (await run(condition)) return;
      await sleep(20);
    }
    throw new Error(`Timeout: ${label}`);
  };
  const load = async (mode = 'trim') => {
    await win.loadURL(`${origin}/${basename(scratch)}/index.html?mode=${mode}`);
    await wait(
      'typeof editControls!=="undefined" && !!document.querySelector("section")',
      'mounted recovery notice',
    );
  };
  let failed = false;
  try {
    await load();
    await run(
      `${button('恢复并保存裁剪')}.click();${button('编辑当前项目')}.click();editControls.edit();editControls.leave()`,
    );
    assert.equal((await state()).writes, 0);
    assert.equal((await state()).recoveries.length, 1);
    assert.equal((await state()).leaves[0].done, false);
    await run('editControls.recover()');
    await wait(
      'editControls.state().presentations.length === 1',
      'native recovery accepted',
    );
    assert.equal((await state()).leaves[0].done, false);
    assert.equal((await state()).restoring, true);
    await run('editControls.present()');
    await wait('editControls.state().leaves[0].done', 'leave after refresh');
    assert.equal((await state()).leaves[0].result, true);
    assert.equal((await state()).busy, false);
    assert.deepEqual((await state()).accepted, ['A']);
    assert.match(await run('document.body.innerText'), /裁剪修改已恢复并保存/);
    console.log(
      'PASS recovery locks synchronously against old same-turn editing and leave waits native restore plus presentation',
    );

    await load();
    await click('恢复并保存裁剪');
    await run('editControls.leave();editControls.recover(true)');
    await wait(
      'editControls.state().leaves[0].done',
      'failed recovery captured',
    );
    assert.equal((await state()).leaves[0].result, false);
    assert.equal((await state()).current.canvas.cards[0].trims, undefined);
    assert.equal((await state()).busy, false);
    await click('编辑当前项目');
    assert.equal((await state()).writes, 1);
    assert.equal(await run(`${button('恢复并保存裁剪')}.disabled`), false);
    await click('恢复并保存裁剪');
    await run('editControls.recover()');
    await wait(
      'editControls.state().presentations.length===1',
      'retry native success',
    );
    await run('editControls.present()');
    await wait('!editControls.state().busy', 'retry completed');
    console.log(
      'PASS failed native recovery preserves old content, reports leave failure, and releases editing/retry controls',
    );

    await load();
    await click('恢复并保存裁剪');
    await run('editControls.switchProject("B")');
    await wait(
      'document.querySelector("h1").textContent === "项目B"',
      'forced switch',
    );
    await run('editControls.recover()');
    await wait('!editControls.state().busy', 'old native reply settles');
    assert.deepEqual((await state()).presentations, []);
    assert.deepEqual((await state()).accepted, []);
    assert.equal((await state()).current.project.id, 'B');
    assert.equal((await state()).current.canvas.cards[0].trims, undefined);
    assert.equal(await run(`${button('恢复并保存裁剪')}.disabled`), false);
    console.log(
      'PASS native reply from a forced-away project cannot replace the new project and releases pending UI',
    );

    await load();
    await click('恢复并保存裁剪');
    await run('editControls.switchProject("B")');
    await wait(
      'editControls.state().current.project.id === "B"',
      'away before same-id reopen',
    );
    await run('editControls.switchProject("A")');
    await wait(
      'editControls.state().current.project.id === "A"',
      'same-id new context',
    );
    await run('editControls.recover()');
    await wait('!editControls.state().busy', 'old same-id reply settled');
    assert.deepEqual((await state()).accepted, []);
    assert.deepEqual((await state()).presentations, []);
    assert.equal((await state()).current.canvas.cards[0].trims, undefined);
    assert.doesNotMatch(
      await run('document.body.innerText'),
      /裁剪修改已恢复并保存/,
    );
    console.log(
      'PASS A-to-B-to-A reopening rejects the old context reply even when its project ID matches again',
    );

    await load();
    await click('恢复并保存裁剪');
    await run('editControls.recover()');
    await wait(
      'editControls.state().presentations.length===1',
      'delayed old presentation',
    );
    await run('editControls.delayLists(true);editControls.switchProject("B")');
    await wait(
      'editControls.state().lists.at(-1)==="B"',
      'new project list queued',
    );
    const before = (await state()).lists.length;
    await run('editControls.present()');
    await wait('!editControls.state().busy', 'old presentation settles');
    assert.equal((await state()).lists.length, before);
    await run('editControls.list()');
    await wait(`!!${button('恢复并保存裁剪')}`, 'new project records survive');
    assert.equal((await state()).current.project.id, 'B');
    assert.equal(await run(`${button('恢复并保存裁剪')}.disabled`), false);
    console.log(
      'PASS late old presentation does not invalidate a new project recovery-list request',
    );

    await load('conflict');
    assert.equal(await run(`${button('恢复并保存裁剪')}.disabled`), true);
    await click('导出恢复文件');
    await wait(
      'editControls.state().exports.length===1',
      'conflicting copy exported',
    );
    assert.equal((await state()).recoveries.length, 0);
    assert.match(await run('document.body.innerText'), /当前内容与原版本不同/);
    console.log(
      'PASS changed canvas conflicts disable recovery while preserving read-only rescue export',
    );

    await load('name');
    await click('继续修改名称');
    await wait(
      '!!document.querySelector("dialog[open]")',
      'name input reopened',
    );
    assert.equal(
      await run('document.querySelector("input").value'),
      '恢复名称A',
    );
    assert.equal((await state()).recoveries.length, 0);
    assert.equal((await state()).protections.length, 0);
    assert.equal((await state()).nameEditor.sessionId, 'stream-A');
    assert.equal((await state()).nameEditor.key.seq, 3);
    console.log(
      'PASS continuing a name opens the existing draft in the real explicit-save dialog without native recovery',
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    failed = true;
    console.error(error);
    console.error(errors);
    console.error(await run('document.body.innerText'));
    console.error(await state());
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
