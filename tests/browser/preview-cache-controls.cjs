// Real Settings controls with delayed typed IPC; never reads or deletes real media.
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
  mkdtempSync(join(root, 'src/renderer/.preview-cache-controls-'));
const profile =
  process.env.AFFLATUS_FIXTURE_PROFILE ??
  mkdtempSync(join(tmpdir(), 'afflatus-preview-cache-controls-'));
app.setPath('userData', profile);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>预览缓存设置回归</title></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/preview-cache-controls.fixture.tsx"></script></body></html>`,
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
  const panel = 'document.querySelector("section[aria-label=预览缓存]")';
  const preview =
    'document.querySelector("section[aria-label=预览缓存清理预览]")';
  const button = (label) =>
    `[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')??b.textContent.trim())===${JSON.stringify(label)})`;
  const click = (label) =>
    run(`{ const button=${button(label)}; button.focus(); button.click(); }`);
  const state = () => run('previewCacheControls.state()');
  const text = () => run(`${panel}.innerText`);
  const wait = async (condition, label) => {
    for (let n = 0; n < 250; n++) {
      if (await run(condition)) return;
      await sleep(20);
    }
    throw new Error(`Timeout: ${label}`);
  };
  const ready = () =>
    wait(
      `${panel}.getAttribute('aria-busy') === 'false'`,
      'cache controls idle',
    );
  const load = async () => {
    await win.loadURL(`${origin}/${basename(scratch)}/index.html`);
    await wait(
      'typeof previewCacheControls !== "undefined" && !!document.querySelector("dialog[open]")',
      'settings opened',
    );
  };
  const storage = async () => {
    await click('保存与存储');
    await wait(`${panel}.checkVisibility()`, 'storage visible');
  };
  const inspect = async () => {
    const count = (await state()).previews;
    await run(
      `{ const button=[...${panel}.querySelectorAll('button')].find(b=>['检查预览缓存','重新检查缓存'].includes(b.textContent.trim())); button.focus(); button.click(); }`,
    );
    await wait(
      `previewCacheControls.state().previews === ${count + 1}`,
      'one preview requested',
    );
  };
  const checked = async (expires = 60000, empty = false) => {
    await inspect();
    await run(`previewCacheControls.preview(undefined, ${expires}, ${empty})`);
    await ready();
    await wait(`!!${preview}`, 'preview visible');
  };
  const confirm = '确认清理 2 个缓存文件';
  let failed = false;
  try {
    await load();
    assert.equal((await state()).previews, 0);
    await storage();
    assert.equal((await state()).previews, 0);
    assert.match(await text(), /原素材、编辑草稿、完整结果和暂存文件均保留/);
    await checked();
    assert.equal(
      (await state()).inspections,
      0,
      'no redundant read before the aggregate preview',
    );
    assert.deepEqual((await state()).executions, []);
    assert.match(
      await text(),
      /已检查 5 项受管预览 · 缓存目录已核实占用 8,527 字节/,
    );
    assert.match(await text(), /可清理 2 个缓存文件，释放 1,538 字节/);
    assert.match(await text(), /以上占用不是完整总量/);
    assert.equal(
      await run('document.activeElement.textContent'),
      '预览缓存检查结果',
    );
    await run(
      `${preview}.querySelectorAll('details').forEach(item => { item.open = true; })`,
    );
    for (const reason of [
      '正在使用，已保留',
      '正在生成，已保留',
      '原素材不可用，已保留',
      '身份不明的文件，已保留',
      '目录无法安全核实',
    ])
      assert.match(await text(), new RegExp(reason));
    await run(
      `${preview}.scrollIntoView({block:'center'}); Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{})))`,
    );
    const screenshot =
      process.env.AFFLATUS_PREVIEW_CACHE_SCREENSHOT ??
      join(tmpdir(), 'afflatus-preview-cache-controls.png');
    writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    console.log(`SCREENSHOT simulated IPC: ${screenshot}`);
    await click('暂不清理缓存');
    await ready();
    assert.equal(await run(`!!${preview}`), false);
    assert.equal((await state()).cancellations, 1);
    assert.deepEqual((await state()).executions, []);
    assert.equal(
      await run('document.activeElement.textContent.trim()'),
      '检查预览缓存',
    );
    console.log(
      'PASS read-only explicit inspection shows measured occupancy, unknown-size caveat and retained reasons; cancellation deletes nothing and restores focus',
    );

    await load();
    await storage();
    await run(
      `{ const b=${button('检查预览缓存')}; b.focus(); b.click(); b.click(); }`,
    );
    assert.equal((await state()).previews, 1);
    await click('取消检查');
    await ready();
    assert.equal((await state()).cancellations, 1);
    assert.equal(
      await run('document.activeElement.textContent.trim()'),
      '检查预览缓存',
    );
    await inspect();
    await run('previewCacheControls.preview(1, 60000, true)');
    await ready();
    await run('previewCacheControls.preview(0)');
    await sleep(60);
    assert.match(await text(), /没有可安全清理的预览缓存/);
    assert.equal(await run(`!!${button(confirm)}`), false);
    assert.deepEqual((await state()).executions, []);
    console.log(
      'PASS repeated inspection launches once; a cancelled late scan cannot replace a newer empty result or authorize cleanup',
    );

    await load();
    await storage();
    await checked(100);
    await wait(`${button(confirm)}.disabled`, 'expiry disables confirmation');
    assert.match(await text(), /此预览已失效，请重新检查后确认/);
    await click(confirm);
    assert.deepEqual((await state()).executions, []);
    await inspect();
    await run('previewCacheControls.failPreview()');
    await ready();
    assert.match(await text(), /缓存目录暂不可读/);
    assert.equal(await run(`${button(confirm)}.disabled`), true);
    console.log(
      'PASS expired previews and failed reinspection cannot reuse old authorization',
    );

    await load();
    await storage();
    await checked();
    await run(
      `{ const b=${button(confirm)}; b.focus(); b.click(); b.click(); }`,
    );
    assert.deepEqual((await state()).executions, ['preview-0']);
    assert.equal(await run(`${button('正在清理缓存…')}.disabled`), true);
    await run('previewCacheControls.finish(undefined, true)');
    await ready();
    assert.match(await text(), /已清理 1 个缓存文件，实际释放 513 字节/);
    await run(
      `${panel}.querySelectorAll('details').forEach(item=>{item.open=true;})`,
    );
    assert.match(await text(), /文件被占用，未清理/);
    assert.equal(await run(`!!${preview}`), false);
    assert.match(
      await run('document.activeElement.textContent'),
      /实际释放 513 字节/,
    );
    await inspect();
    await run('previewCacheControls.failPreview()');
    await ready();
    assert.match(await text(), /实际释放 513 字节/);
    assert.match(await text(), /缓存目录暂不可读/);
    assert.equal((await state()).executions.length, 1);
    console.log(
      'PASS repeated confirmation executes once; partial failure reports actual bytes and retains the outcome after a failed new scan',
    );

    await load();
    await storage();
    await checked();
    await click(confirm);
    await run('previewCacheControls.failExecution()');
    await ready();
    assert.match(await text(), /缓存或原素材已变化/);
    assert.equal(await run(`${button(confirm)}.disabled`), true);
    await click(confirm);
    assert.equal((await state()).executions.length, 1);
    await checked();
    assert.equal((await state()).executions.length, 1);
    await click(confirm);
    assert.deepEqual((await state()).executions, ['preview-0', 'preview-1']);
    await run('previewCacheControls.finish()');
    await ready();
    assert.match(await text(), /实际释放 1,538 字节/);
    console.log(
      'PASS a rejected native token requires a new scan and a separate explicit confirmation',
    );

    await load();
    await storage();
    await inspect();
    await click('交互与快捷键');
    await wait(
      'previewCacheControls.state().cancellations === 1',
      'tab switch cancels pending scan',
    );
    await run('previewCacheControls.preview(0)');
    await sleep(60);
    assert.equal(
      await run('document.activeElement.textContent.trim()'),
      '交互与快捷键',
    );
    await storage();
    await ready();
    assert.equal(await run(`!!${preview}`), false);
    await checked();
    await click('视频处理');
    await wait(
      'previewCacheControls.state().cancellations === 2',
      'tab switch revokes ready token',
    );
    await storage();
    assert.equal(await run(`!!${preview}`), false);
    assert.deepEqual((await state()).executions, []);
    console.log(
      'PASS switching categories invalidates pending and completed previews without stealing focus or deleting hidden files',
    );

    await inspect();
    await run('previewCacheControls.block(true)');
    await wait(
      'previewCacheControls.state().cancellations === 3',
      'write block cancels inspection',
    );
    await run('previewCacheControls.preview(2)');
    await ready();
    assert.equal(await run(`${button('检查预览缓存')}.disabled`), true);
    assert.match(await text(), /项目存储正在处理中/);
    await run('previewCacheControls.block(false)');
    await wait(
      `!${button('检查预览缓存')}.disabled`,
      'write admission restored',
    );
    assert.equal(await run(`!!${preview}`), false);
    await checked();
    await run('previewCacheControls.block(true)');
    await wait(`!${preview}`, 'write block revokes ready preview');
    await run('previewCacheControls.block(false)');
    assert.deepEqual((await state()).executions, []);
    await run('previewCacheControls.cleanupMigration(true)');
    await wait(
      `${button('检查预览缓存')}.disabled`,
      'pending old-directory cleanup blocks preview deletion after write admission opens',
    );
    await run('previewCacheControls.cleanupMigration(false)');
    await wait(
      `!${button('检查预览缓存')}.disabled`,
      'migration fully complete',
    );
    console.log(
      'PASS storage admission changes revoke authorization and cannot resurrect an old preview',
    );

    await load();
    await storage();
    await checked();
    await click(confirm);
    await run(`{ const b=${button('停止剩余清理')}; b.click(); b.click(); }`);
    assert.equal((await state()).cancellations, 1);
    assert.equal(await run(`${button('正在停止…')}.disabled`), true);
    assert.equal(await run(`${button('重新检查缓存')}.disabled`), true);
    await run('previewCacheControls.finish(undefined, true, true)');
    await ready();
    assert.match(
      await text(),
      /清理已停止：已清理 1 个缓存文件，实际释放 513 字节/,
    );
    await checked();
    await click(confirm);
    await click('交互与快捷键');
    await wait(
      'previewCacheControls.state().cancellations === 2',
      'leaving stops remaining confirmed cleanup',
    );
    await run('previewCacheControls.finish(undefined, true, true)');
    await sleep(60);
    assert.equal(
      await run('document.activeElement.textContent.trim()'),
      '交互与快捷键',
    );
    await storage();
    await ready();
    assert.match(
      await text(),
      /清理已停止：已清理 1 个缓存文件，实际释放 513 字节/,
    );
    assert.equal(await run(`!!${preview}`), false);
    console.log(
      'PASS stopping waits for real partial results, sends one cancellation, and keeps confirmed outcomes across category changes',
    );

    await load();
    await storage();
    await checked();
    await click(confirm);
    await run('previewCacheControls.rejectNextCancel()');
    await click('交互与快捷键');
    await wait(
      `${panel}.textContent.includes('取消通道暂不可用')`,
      'failed visibility cancellation recorded',
    );
    await storage();
    await wait(
      `!!${button('停止剩余清理')} && !${button('停止剩余清理')}.disabled`,
      'cancellation retry remains available without preview',
    );
    assert.equal(await run(`!!${preview}`), false);
    assert.match(await text(), /清理仍在进行，可再次尝试停止/);
    assert.equal((await state()).executions.length, 1);
    await click('停止剩余清理');
    assert.equal((await state()).cancellations, 2);
    assert.equal(await run(`${button('正在停止…')}.disabled`), true);
    await run('previewCacheControls.finish(undefined, true, true)');
    await ready();
    assert.match(await text(), /实际释放 513 字节/);
    assert.equal((await state()).executions.length, 1);
    console.log(
      'PASS failed cancellation during a category switch remains retryable without a preview and never repeats cleanup execution',
    );

    await load();
    await storage();
    await inspect();
    await run('previewCacheControls.show(false)');
    await wait('!document.querySelector("dialog")', 'settings unmounted');
    await run('previewCacheControls.show(true)');
    await wait(
      '!!document.querySelector("dialog[open]")',
      'settings remounted',
    );
    await storage();
    await inspect();
    await run('previewCacheControls.preview(1, 60000, true)');
    await ready();
    await run('previewCacheControls.preview(0)');
    await sleep(60);
    assert.match(await text(), /没有可安全清理的预览缓存/);
    assert.equal(await run(`!!${button(confirm)}`), false);
    await checked();
    await click(confirm);
    await run('previewCacheControls.show(false)');
    await wait(
      '!document.querySelector("dialog")',
      'confirmed operation unmounted',
    );
    await run('previewCacheControls.show(true)');
    await wait(
      '!!document.querySelector("dialog[open]")',
      'fresh settings opened',
    );
    await storage();
    await run('previewCacheControls.finish(0, true, true)');
    await sleep(60);
    assert.doesNotMatch(await text(), /上次清理|清理已停止/);
    assert.equal(await run(`!!${preview}`), false);
    console.log(
      'PASS close/reopen isolates late scans and old cleanup replies; unmount requests cancellation without authorizing new deletion',
    );

    await checked();
    await run('previewCacheControls.rejectNextCancel()');
    await click('暂不清理缓存');
    await wait(
      `${panel}.innerText.includes('取消通道暂不可用')`,
      'cancellation failure visible',
    );
    assert.equal(await run(`!!${preview}`), false);
    assert.equal((await state()).executions.length, 1);
    await checked();
    assert.equal((await state()).executions.length, 1);
    console.log(
      'PASS cancellation failure is visible while old authorization stays revoked; later inspection never auto-executes',
    );
    await inspect();
    await run(`${button('创建本机备份')}.focus()`);
    await run('previewCacheControls.preview()');
    await ready();
    assert.equal(
      await run('document.activeElement.textContent.trim()'),
      '创建本机备份',
    );
    console.log(
      'PASS a completed scan does not steal focus from another storage control',
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
      console.error('Fixture cleanup failed:', error);
    } finally {
      app.exit(failed ? 1 : 0);
    }
  }
});
