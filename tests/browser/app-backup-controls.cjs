// Actual Settings/React lifecycle; only the native backup calls are delayed mocks.
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
  mkdtempSync(join(root, 'src/renderer/.app-backup-controls-'));
const profile =
  process.env.AFFLATUS_FIXTURE_PROFILE ??
  mkdtempSync(join(tmpdir(), 'afflatus-app-backup-controls-'));
app.setPath('userData', profile);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>应用索引备份回归</title></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/app-backup-controls.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 1000,
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
  const state = () => run('backupControls.state()');
  const text = () =>
    run(
      'document.querySelector("section[aria-label=应用索引与设置备份]").innerText',
    );
  const wait = async (condition, label) => {
    for (let n = 0; n < 250; n++) {
      if (await run(condition)) return;
      await sleep(20);
    }
    throw new Error(`Timeout: ${label}`);
  };
  const ready = () =>
    wait(
      `!!${button('刷新备份列表')} && !${button('刷新备份列表')}.disabled`,
      'operation finished',
    );
  const load = async (mode = 'existing', read = true) => {
    await win.loadURL(`${origin}/${basename(scratch)}/index.html?mode=${mode}`);
    await wait(
      '!!document.querySelector("dialog[open]") && typeof backupControls!=="undefined"',
      'settings mounted',
    );
    await click('保存与存储');
    await wait('backupControls.state().lists===1', 'one storage read');
    if (read) {
      await run('backupControls.list()');
      await ready();
    }
  };
  let failed = false;
  try {
    await win.loadURL(`${origin}/${basename(scratch)}/index.html`);
    await wait(
      '!!document.querySelector("dialog[open]") && typeof backupControls!=="undefined"',
      'initial settings',
    );
    await run(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    assert.equal((await state()).lists, 0);
    assert.equal((await state()).creates, 0);
    await click('保存与存储');
    await wait('backupControls.state().lists===1', 'lazy scan');
    await run('backupControls.list()');
    await ready();
    assert.match(await text(), /原项目保存目录：\/原项目目录/);
    assert.match(await text(), /3 个项目 · 2 条历史任务 · 32,768 字节/);
    assert.match(await text(), /不包含项目媒体、暂存结果或独立恢复草稿/);
    assert.match(await text(), /恢复仅在应用启动失败时提供/);
    assert.equal(
      await run(
        '!![...document.querySelectorAll("button")].find(b=>/恢复备份|立即恢复|替换数据库/.test(b.textContent))',
      ),
      false,
    );
    await click('交互与快捷键');
    await click('保存与存储');
    assert.equal((await state()).lists, 1);
    console.log(
      'PASS StrictMode and inactive settings do not scan/create; storage opens one read and displays precise scope without restore controls',
    );

    await run(
      `{ const button = ${button('创建本机备份')}; button.click(); button.click(); }`,
    );
    assert.equal((await state()).creates, 1);
    await run('backupControls.create()');
    await wait('backupControls.state().lists===2', 'post-create refresh');
    await run('backupControls.list()');
    await ready();
    assert.match(await text(), /已创建本机备份/);
    assert.equal(
      await run(
        'document.querySelectorAll("ul[aria-label=本机应用备份列表]>li").length',
      ),
      2,
    );
    assert.equal((await state()).creates, 1);
    console.log(
      'PASS explicit creation is deduplicated and refreshes the list only after success',
    );

    await click('创建本机备份');
    await run('backupControls.failCreate()');
    await ready();
    assert.match(await text(), /磁盘空间不足/);
    assert.match(await text(), /已创建本机备份/);
    assert.equal(
      await run(
        'document.querySelectorAll("ul[aria-label=本机应用备份列表]>li").length',
      ),
      2,
    );
    await click('刷新备份列表');
    await run('backupControls.failList()');
    await ready();
    assert.match(await text(), /目录暂时无法读取/);
    assert.equal(
      await run(
        'document.querySelectorAll("ul[aria-label=本机应用备份列表]>li").length',
      ),
      2,
    );
    console.log(
      'PASS failed creation and refresh preserve the existing backup list and last successful result',
    );

    await load();
    await click('创建本机备份');
    await run('backupControls.create()');
    await wait(
      'backupControls.state().lists===2',
      'creation succeeded before refresh fails',
    );
    await run('backupControls.failList()');
    await ready();
    assert.match(await text(), /备份已创建，但列表刷新失败/);
    assert.match(await text(), /已创建本机备份/);
    assert.equal(
      await run(
        'document.querySelectorAll("ul[aria-label=本机应用备份列表]>li").length',
      ),
      2,
    );
    await click('刷新备份列表');
    await run('backupControls.list()');
    await ready();
    assert.doesNotMatch(await text(), /列表刷新失败/);
    console.log(
      'PASS a post-create read failure never misreports a completed backup as failed',
    );

    await load('invalid');
    assert.match(await text(), /当前不能用于恢复：备份来自不支持的较新版本/);
    assert.match(await text(), /原文件已保留/);
    await click('打开备份位置');
    await run('backupControls.reveal(true)');
    await ready();
    assert.match(await text(), /无法打开备份位置/);
    assert.deepEqual((await state()).reveals, [false]);
    assert.equal((await state()).creates, 0);
    console.log(
      'PASS unsupported/damaged files stay visible with reasons and folder failures have a clear non-destructive error',
    );

    await load('recovered');
    assert.match(await text(), /上次恢复/);
    assert.match(await text(), /保留待核对：2 条历史任务 · 3 个文件/);
    assert.match(await text(), /\/应用数据\/retained\/原资料/);
    await click('打开保留资料位置');
    await run('backupControls.reveal()');
    await ready();
    assert.deepEqual((await state()).reveals, [true]);
    assert.equal((await state()).creates, 0);
    console.log(
      'PASS restoration reports expose retained data location and counts without replaying historical jobs',
    );

    await load('existing', false);
    await run('backupControls.show(false)');
    await wait('!document.querySelector("dialog")', 'unmounted old scan');
    await run('backupControls.show(true)');
    await wait('!!document.querySelector("dialog[open]")', 'new settings');
    await click('保存与存储');
    await wait('backupControls.state().lists===2', 'new scan');
    await run('backupControls.list(1,"/新读取项目目录")');
    await ready();
    await run('backupControls.list(0,"/迟到旧目录")');
    assert.match(await text(), /新读取项目目录/);
    assert.doesNotMatch(await text(), /迟到旧目录/);
    console.log(
      'PASS an unmounted scan cannot overwrite a newer settings instance',
    );

    await load();
    await click('创建本机备份');
    await run('backupControls.show(false)');
    await wait('!document.querySelector("dialog")', 'closed during creation');
    await run('backupControls.create()');
    assert.equal((await state()).lists, 1);
    await run('backupControls.show(true)');
    await wait(
      '!!document.querySelector("dialog[open]")',
      'reopen after late creation',
    );
    await click('保存与存储');
    await wait(
      'backupControls.state().lists===2',
      'read durable completed backup',
    );
    await run('backupControls.list()');
    await ready();
    assert.equal(
      await run(
        'document.querySelectorAll("ul[aria-label=本机应用备份列表]>li").length',
      ),
      2,
    );
    console.log(
      'PASS closing settings never cancels or loses a completed native backup; reopening reads it normally',
    );

    await load('empty');
    assert.match(await text(), /暂无本机备份/);
    await run('backupControls.block(true)');
    await wait(`${button('创建本机备份')}.disabled`, 'storage write lock');
    await click('创建本机备份');
    assert.equal((await state()).creates, 0);
    assert.equal(await run(`${button('刷新备份列表')}.disabled`), false);
    console.log(
      'PASS empty-state and busy storage are explicit while read-only refresh remains available',
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
