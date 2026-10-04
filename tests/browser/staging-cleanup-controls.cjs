// Real React/settings controls with delayed typed IPC, isolated from the user's library.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = resolve(__dirname, '../..');
const scratch =
  process.env.AFFLATUS_FIXTURE_SCRATCH ??
  mkdtempSync(join(root, 'src/renderer/.staging-cleanup-controls-'));
const profile =
  process.env.AFFLATUS_FIXTURE_PROFILE ??
  mkdtempSync(join(tmpdir(), 'afflatus-cleanup-controls-'));
app.setPath('userData', profile);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>暂存回收回归</title></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/staging-cleanup-controls.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { backgroundThrottling: false, offscreen: true },
  });
  const run = (source) => win.webContents.executeJavaScript(source);
  const errors = [];
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const button = (label) =>
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
  const click = (label) => run(`${button(label)}.click()`);
  const state = () => run('cleanupControls.state()');
  const text = () => run('document.body.innerText');
  const wait = async (source, label) => {
    for (let i = 0; i < 200; i++) {
      if (await run(source)) return;
      await sleep(20);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const load = async (ready = true) => {
    await win.loadURL(
      `${process.env.AFFLATUS_FIXTURE_ORIGIN ?? 'http://127.0.0.1:5173'}/${basename(scratch)}/index.html`,
    );
    await wait(
      'cleanupControls.state().inspections === 1',
      'one StrictMode inspection',
    );
    if (ready) {
      await run('cleanupControls.inspect()');
      await wait(`!!${button('重试保存')}`, 'verified ready retry');
    }
  };
  const open = async () => {
    await click('管理暂存');
    await wait(
      '!!document.querySelector("dialog[open]")',
      'storage settings opened',
    );
    await wait(
      `!!${button('检查未完成导入')}`,
      'cleanup entry in existing settings',
    );
  };
  const preview = async () => {
    const count = (await state()).previews;
    await click(count ? '重新检查' : '检查未完成导入');
    await wait(
      `cleanupControls.state().previews === ${count + 1}`,
      'preview requested',
    );
    await run('cleanupControls.preview()');
    await wait(
      `!${button('清理 2 个临时文件')}.disabled`,
      'exact preview ready',
    );
  };
  let failed = false;
  try {
    await load();
    assert.match(await text(), /1 个结果待保存 · 1 项导入未完成/);
    assert.match(
      await text(),
      /取消导入.mp4：导入已取消，未完成内容未加入项目/,
    );
    assert.equal(
      await run(
        "[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='重试保存').length",
      ),
      1,
    );
    await run('cleanupControls.refresh()');
    await sleep(80);
    assert.equal((await state()).inspections, 1);
    await run('cleanupControls.changeOtherJob()');
    await wait(
      'cleanupControls.state().inspections === 2',
      'changed job triggers read',
    );
    assert.equal(
      await run(`!!${button('重试保存')}`),
      true,
      'unchanged complete job retains its verified retry while another job is checked',
    );
    await click('重试保存');
    assert.deepEqual((await state()).retryIds, ['完整结果']);
    await run('cleanupControls.inspect()');
    console.log(
      'PASS cancelled intake with a digest never gains retry; a verified complete result retains retry across unrelated refreshes and inspections',
    );

    await load(false);
    await run('cleanupControls.changeJob()');
    await wait(
      'cleanupControls.state().inspections === 2',
      'new job version inspected',
    );
    await run('cleanupControls.inspect(1, false)');
    await sleep(30);
    await run('cleanupControls.inspect(0, true)');
    await sleep(50);
    assert.equal(await run(`!!${button('重试保存')}`), false);
    console.log(
      'PASS an old read-only inspection cannot authorize retry for a changed job',
    );

    await load();
    await open();
    await preview();
    assert.equal(
      (await state()).inspections,
      1,
      'cleanup preview does not request a redundant classification first',
    );
    assert.match(await text(), /可清理 2 个临时文件 · 1,538 字节/);
    await run(
      "document.querySelectorAll('section[aria-label=暂存清理预览] details').forEach(d=>d.open=true)",
    );
    const full = await text();
    assert.match(full, /取消导入.mp4/);
    assert.match(full, /接收失败.wav/);
    assert.match(full, /完整结果.mp4/);
    assert.match(full, /云端结果不在本地导入回收范围/);
    assert.match(full, /缺少创建归属记录，历史文件已保留/);
    assert.equal(
      await run(
        "document.querySelector('section[aria-label=暂存清理预览] details ul').children.length",
      ),
      2,
    );
    await click('暂不清理');
    assert.equal(
      await run('!!document.querySelector("section[aria-label=暂存清理预览]")'),
      false,
    );
    assert.deepEqual((await state()).executions, []);
    console.log(
      'PASS one aggregate settings entry shows exact owned-part scope and retained ready/cloud/legacy files; cancelling performs no deletion',
    );

    await load();
    await open();
    await preview();
    await run(
      `${button('清理 2 个临时文件')}.click(); ${button('清理 2 个临时文件')}.click()`,
    );
    await wait(
      'cleanupControls.state().executions.length === 1',
      'one cleanup execution',
    );
    assert.equal(await run(`${button('正在清理…')}.disabled`), true);
    await run('cleanupControls.execute(true)');
    await wait(
      'document.body.innerText.includes("已清理 1 个临时文件，释放 513 字节")',
      'actual partial outcome',
    );
    assert.match(await text(), /仍需处理：接收失败.wav：文件被占用，未清理/);
    assert.equal(await run(`${button('清理 2 个临时文件')}.disabled`), true);
    await click('重新检查');
    await run('cleanupControls.failPreview()');
    await wait(
      'document.body.innerText.includes("暂存目录暂不可读")',
      'new check failure visible',
    );
    assert.match(await text(), /已清理 1 个临时文件，释放 513 字节/);
    assert.match(await text(), /可清理 2 个临时文件 · 1,538 字节/);
    assert.equal(await run(`${button('清理 2 个临时文件')}.disabled`), true);
    console.log(
      'PASS duplicate confirmation runs once; partial cleanup reports only actual bytes and failed recheck retains the previous result without authorizing old scope',
    );

    await load();
    await open();
    await preview();
    await click('清理 2 个临时文件');
    await run('cleanupControls.failExecution()');
    await wait(
      'document.body.innerText.includes("文件或任务已变化")',
      'changed files reject old token',
    );
    assert.equal(await run(`${button('清理 2 个临时文件')}.disabled`), true);
    await click('清理 2 个临时文件');
    assert.equal((await state()).executions.length, 1);
    await click('重新检查');
    await run('cleanupControls.preview()');
    await wait(
      `!${button('清理 2 个临时文件')}.disabled`,
      'fresh scope requires another confirmation',
    );
    assert.equal((await state()).executions.length, 1);
    await click('清理 2 个临时文件');
    assert.deepEqual((await state()).executions, ['preview-0', 'preview-1']);
    await run('cleanupControls.execute()');
    await wait(
      'document.body.innerText.includes("已清理 2 个临时文件，释放 1,538 字节")',
      'new confirmation completes',
    );
    console.log(
      'PASS a changed file/job invalidates confirmation; only a new preview and explicit confirmation can execute again',
    );

    await load();
    await open();
    await click('检查未完成导入');
    await wait('cleanupControls.state().previews === 1', 'old modal checking');
    await run('cleanupControls.close()');
    await wait('!document.querySelector("dialog[open]")', 'old modal closed');
    await open();
    await click('检查未完成导入');
    await wait('cleanupControls.state().previews === 2', 'new modal checking');
    await run('cleanupControls.emptyPreview(1)');
    await wait(
      'document.body.innerText.includes("没有可安全清理的临时文件")',
      'new empty report',
    );
    await run('cleanupControls.preview(0)');
    await sleep(60);
    assert.match(await text(), /可清理 0 个临时文件 · 0 字节/);
    assert.equal(await run(`!!${button('清理 2 个临时文件')}`), false);
    console.log(
      'PASS closing/reopening settings isolates late preview replies and an empty eligible scope cannot be cleaned',
    );

    await load();
    await open();
    await click('检查未完成导入');
    await run('cleanupControls.preview(0, 100)');
    await wait(`!!${button('清理 2 个临时文件')}`, 'short-lived preview');
    await wait(
      `${button('清理 2 个临时文件')}.disabled`,
      'preview expiry disables confirmation',
    );
    await click('清理 2 个临时文件');
    assert.deepEqual((await state()).executions, []);
    assert.match(await text(), /此预览不能继续执行，请重新检查后确认/);
    console.log(
      'PASS expired preview retains its details but cannot authorize deletion',
    );

    await load();
    await run('cleanupControls.migrate(false)');
    await open();
    await wait(
      `!!${button('取消迁移')}`,
      'ordinary migration retains cancellation',
    );
    assert.match(await text(), /正在迁移项目目录，新结果将暂存后自动保存/);
    await run('cleanupControls.migrate(true)');
    await wait(
      `!${button('取消迁移')}`,
      'interrupted cutover has no ineffective cancel',
    );
    const restartNotice = '目录切换确认中断，写入已暂停，请关闭并重新打开应用';
    assert.match(await text(), new RegExp(restartNotice));
    assert.doesNotMatch(await text(), /正在校验文件|新结果将暂存后自动保存/);
    for (const label of ['修改保存目录', '创建本机备份', '重试保存'])
      assert.equal(
        await run(`${button(label)}.disabled`),
        true,
        `${label} must stay unavailable until restart`,
      );
    assert.equal(
      await run('!!document.querySelector("dialog[open] progress")'),
      false,
    );
    await run(
      'document.querySelector("dialog[open] button[aria-label=关闭]").click()',
    );
    await wait(
      '!document.querySelector("dialog[open]")',
      'settings closes without hiding the restart state',
    );
    assert.match(await text(), new RegExp(restartNotice));
    assert.doesNotMatch(await text(), /自动保存/);
    await run('cleanupControls.migrate(false)');
    await open();
    await wait(
      `!!${button('取消迁移')}`,
      'normal migration behavior is unchanged',
    );
    assert.match(await text(), /正在校验文件/);
    console.log(
      'PASS interrupted cutover remains visible outside settings, disables ineffective writes and cancellation, and does not change ordinary migration behavior',
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    failed = true;
    console.error(error);
    console.error(errors);
    console.error(await text());
  } finally {
    win.destroy();
    try {
      if (!process.env.AFFLATUS_FIXTURE_SCRATCH)
        rmSync(scratch, { recursive: true, force: true });
      if (!process.env.AFFLATUS_FIXTURE_PROFILE)
        rmSync(profile, { recursive: true, force: true });
    } catch (error) {
      failed = true;
      console.error('Fixture cleanup failed:', error);
    } finally {
      app.exit(failed ? 1 : 0);
    }
  }
});
