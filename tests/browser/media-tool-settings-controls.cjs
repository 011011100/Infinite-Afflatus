// Real React controls with delayed typed IPC; no user's profile or native tools are used.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = resolve(__dirname, '../..');
const origin = process.env.AFFLATUS_FIXTURE_ORIGIN;
if (!origin)
  throw new Error('Run through pnpm test:browser media-tool-settings-controls');
const scratch =
  process.env.AFFLATUS_FIXTURE_SCRATCH ??
  mkdtempSync(join(root, 'src/renderer/.media-tool-settings-controls-'));
const profile =
  process.env.AFFLATUS_FIXTURE_PROFILE ??
  mkdtempSync(join(tmpdir(), 'afflatus-media-tool-controls-'));
app.setPath('userData', profile);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>媒体组件设置回归</title></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/media-tool-settings-controls.fixture.tsx"></script></body></html>`,
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
    `[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent.trim()) === ${JSON.stringify(label)})`;
  const click = (label) => run(`${button(label)}.click()`);
  const state = () => run('toolsControls.state()');
  const text = () => run('document.body.innerText');
  const row = (name) =>
    run(`document.querySelector('section[aria-label="${name}"]').innerText`);
  const wait = async (source, label) => {
    for (let i = 0; i < 250; i++) {
      if (await run(source)) return;
      await sleep(20);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const ready = () =>
    wait(`!${button('选择 FFprobe 程序')}.disabled`, 'settings read finished');
  const load = async (mode = 'auto', read = true) => {
    await win.loadURL(`${origin}/${basename(scratch)}/index.html?mode=${mode}`);
    await wait(
      'typeof toolsControls !== "undefined" && toolsControls.state().reads === 1',
      'one StrictMode read',
    );
    if (read) {
      await run('toolsControls.read()');
      await wait(
        '!document.body.innerText.includes("正在读取组件设置…")',
        'read settled',
      );
    }
  };
  const check = async () => {
    await click('检查组件');
    await run('toolsControls.check()');
    await wait(
      'document.body.innerText.includes("上次检查：")',
      'explicit versions checked',
    );
  };
  let failed = false;
  try {
    await load();
    assert.equal((await state()).checks, 0);
    assert.match(await row('FFmpeg'), /系统搜索路径：ffmpeg/);
    assert.doesNotMatch(await text(), /版本 8/);
    await run(`${button('检查组件')}.click(); ${button('检查组件')}.click()`);
    assert.equal((await state()).checks, 1);
    assert.equal(await run(`${button('选择 FFmpeg 程序')}.disabled`), true);
    await run('toolsControls.check()');
    await wait(
      'document.body.innerText.includes("上次检查：")',
      'versions ready',
    );
    assert.match(await row('FFmpeg'), /可运行/);
    assert.match(await row('FFprobe'), /可运行/);
    console.log(
      'PASS opening settings only reads paths; explicit checks run once, show both versions and serialize actions',
    );

    const before = (await state()).stored;
    await click('选择 FFmpeg 程序');
    await run('toolsControls.choose(null)');
    await ready();
    assert.deepEqual((await state()).stored, before);
    assert.match(await row('FFmpeg'), /版本 8.1.auto/);
    assert.doesNotMatch(await text(), /已保存，对新任务生效/);
    console.log(
      'PASS native selection cancellation preserves configuration and the existing report',
    );

    await click('选择 FFmpeg 程序');
    await run('toolsControls.failChoice()');
    await wait(
      'document.body.innerText.includes("所选文件不是 FFmpeg")',
      'specific native error',
    );
    assert.deepEqual((await state()).stored, before);
    assert.doesNotMatch(await text(), /Error invoking remote method/);
    assert.match(await row('FFmpeg'), /版本 8.1.auto/);
    await click('选择 FFmpeg 程序');
    await run('toolsControls.choose(null)');
    await ready();
    assert.match(await text(), /所选文件不是 FFmpeg/);
    console.log(
      'PASS validation failure preserves the old command/report and cancellation does not erase the actionable error',
    );

    await run(
      `${button('选择 FFmpeg 程序')}.click(); ${button('选择 FFmpeg 程序')}.click()`,
    );
    assert.equal((await state()).choices.length, 4);
    await run('toolsControls.choose("/新组件 路径/ffmpeg")');
    await wait(
      'document.body.innerText.includes("已保存，对新任务生效")',
      'save success',
    );
    assert.equal((await state()).stored.paths.ffmpeg, '/新组件 路径/ffmpeg');
    assert.match(await row('FFmpeg'), /版本 8.2.saved/);
    assert.doesNotMatch(await row('FFmpeg'), /8.1.auto/);
    assert.match(await row('FFprobe'), /版本 8.1.auto/);
    assert.doesNotMatch(await text(), /所选文件不是 FFmpeg/);
    assert.match(await text(), /运行中的导出与代理预览继续使用原来的组件/);
    console.log(
      'PASS one successful selection shows the saved path immediately and merges only matching per-tool reports',
    );

    await load('saved');
    await check();
    await run(
      `${button('恢复 FFmpeg 自动查找')}.click(); ${button('恢复 FFmpeg 自动查找')}.click()`,
    );
    assert.deepEqual((await state()).resets, ['ffmpeg']);
    await run('toolsControls.reset()');
    await wait(
      'document.body.innerText.includes("已恢复自动查找")',
      'single tool reset',
    );
    assert.equal((await state()).stored.paths.ffmpeg, null);
    assert.equal((await state()).stored.paths.ffprobe, '/已保存 路径/ffprobe');
    assert.match(await row('FFmpeg'), /系统搜索路径：ffmpeg/);
    assert.match(await row('FFprobe'), /版本 8.2.saved/);
    assert.equal(await run(`!!${button('恢复 FFmpeg 自动查找')}`), false);
    console.log(
      'PASS resetting one tool preserves the other saved path/report and ignores repeated clicks',
    );

    await load('broken');
    assert.match(await text(), /组件配置来自较新版本/);
    assert.equal(await run(`${button('选择 FFmpeg 程序')}.disabled`), true);
    assert.equal(await run(`${button('检查组件')}.disabled`), true);
    await click('选择 FFmpeg 程序');
    assert.deepEqual((await state()).choices, []);
    assert.equal((await state()).stored.paths, null);
    await click('清除两项路径并恢复自动查找');
    assert.deepEqual((await state()).resets, ['all']);
    await run('toolsControls.reset()');
    await ready();
    assert.deepEqual((await state()).stored.paths, {
      ffmpeg: null,
      ffprobe: null,
    });
    assert.doesNotMatch(await text(), /来自较新版本/);
    console.log(
      'PASS invalid/newer configuration is preserved until the explicit two-path reset',
    );

    await load('environment');
    assert.match(await row('FFmpeg'), /由环境变量指定/);
    assert.equal(await run(`${button('选择 FFmpeg 程序')}.disabled`), true);
    assert.equal(await run(`${button('恢复 FFmpeg 自动查找')}.disabled`), true);
    assert.equal(await run(`${button('选择 FFprobe 程序')}.disabled`), false);
    await click('选择 FFmpeg 程序');
    await click('恢复 FFmpeg 自动查找');
    assert.deepEqual((await state()).choices, []);
    assert.deepEqual((await state()).resets, []);
    console.log(
      'PASS environment-managed tools cannot be overwritten or reset while the other tool remains configurable',
    );

    await load('bundled');
    assert.equal((await state()).checks, 0);
    assert.match(await row('FFmpeg'), /应用内置组件/);
    await check();
    assert.match(await row('FFmpeg'), /可运行/);
    await run('toolsControls.bundleState(true)');
    await click('重新检查');
    await run('toolsControls.check()');
    await wait('toolsControls.state().reads === 2', 'changed bundle read');
    await run('toolsControls.read()');
    await ready();
    assert.match(await row('FFmpeg'), /校验失败/);
    assert.doesNotMatch(await row('FFmpeg'), /可运行|版本 8/);
    await run('toolsControls.bundleState(false)');
    await click('重新检查');
    await run('toolsControls.check()');
    await wait('toolsControls.state().reads === 3', 'repaired bundle read');
    await run('toolsControls.read()');
    await ready();
    assert.match(await row('FFmpeg'), /可运行/);
    assert.doesNotMatch(await row('FFmpeg'), /校验失败/);
    await load('bundled-invalid');
    assert.equal((await state()).checks, 0);
    assert.match(await row('FFmpeg'), /校验失败/);
    assert.equal(await run(`${button('选择 FFmpeg 程序')}.disabled`), false);
    await click('选择 FFmpeg 程序');
    await run('toolsControls.choose("/独立组件/ffmpeg")');
    await ready();
    assert.match(await row('FFmpeg'), /已保存的路径|可运行/);
    assert.doesNotMatch(await row('FFmpeg'), /校验失败/);
    assert.match(await row('FFprobe'), /校验失败/);
    console.log(
      'PASS bundled source is read-only on open; integrity changes replace stale reports and invalid bundles keep explicit overrides editable',
    );

    for (const mismatch of ['name', 'source', 'command']) {
      await load();
      await click('检查组件');
      await run(`toolsControls.check(0, ${JSON.stringify(mismatch)})`);
      await ready();
      assert.match(await row('FFmpeg'), /未检查/);
      assert.doesNotMatch(await row('FFmpeg'), /版本 8/);
      assert.match(await row('FFprobe'), /可运行/);
    }
    console.log(
      'PASS results with a stale command, source or tool name cannot mark the current tool available',
    );

    await load();
    await click('检查组件');
    await run('toolsControls.close()');
    await wait(
      '!document.querySelector("section[aria-label=视频处理组件]")',
      'old panel unmounted',
    );
    await run('toolsControls.open()');
    await wait('toolsControls.state().reads === 2', 'new panel read');
    await run('toolsControls.read()');
    await ready();
    await click('选择 FFmpeg 程序');
    await run('toolsControls.choose("/新窗口/ffmpeg")');
    await wait(
      'document.body.innerText.includes("已保存，对新任务生效")',
      'new panel configured',
    );
    await run('toolsControls.check(0)');
    await sleep(80);
    assert.match(await row('FFmpeg'), /版本 8.2.saved/);
    assert.doesNotMatch(await row('FFmpeg'), /8.1.auto/);
    assert.match(await row('FFprobe'), /未检查/);
    assert.match(await text(), /已保存，对新任务生效/);
    console.log(
      'PASS an old check reply cannot update a remounted panel or its newly selected command',
    );

    await load('auto', false);
    await run('toolsControls.close()');
    await wait(
      '!document.querySelector("section[aria-label=视频处理组件]")',
      'read panel unmounted',
    );
    await run('toolsControls.open()');
    await wait('toolsControls.state().reads === 2', 'replacement read');
    await run('toolsControls.read(1)');
    await ready();
    await click('选择 FFmpeg 程序');
    await run('toolsControls.choose("/最后路径/ffmpeg")');
    await wait(
      'document.body.innerText.includes("已保存，对新任务生效")',
      'replacement selection',
    );
    await run('toolsControls.read(0)');
    await sleep(80);
    assert.match(await row('FFmpeg'), /最后路径/);
    console.log(
      'PASS a late initial read after unmount cannot reset the current panel',
    );

    await load('auto', false);
    await run('toolsControls.failRead()');
    await wait(`!!${button('重新读取设置')}`, 'read error retry');
    assert.match(await text(), /配置暂时无法读取/);
    await click('重新读取设置');
    await run('toolsControls.read()');
    await ready();
    assert.equal((await state()).checks, 0);
    assert.doesNotMatch(await text(), /配置暂时无法读取/);
    console.log(
      'PASS failed settings reads have a read-only retry without starting native tool checks',
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
