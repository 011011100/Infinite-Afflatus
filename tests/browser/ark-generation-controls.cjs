// Isolated React/typed IPC fixture. No provider network, keychain, or user's profile.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = resolve(__dirname, '../..');
const origin = process.env.AFFLATUS_FIXTURE_ORIGIN;
if (!origin)
  throw new Error('Run through pnpm test:browser ark-generation-controls');
const scratch =
  process.env.AFFLATUS_FIXTURE_SCRATCH ??
  mkdtempSync(join(root, 'src/renderer/.ark-generation-controls-'));
const profile =
  process.env.AFFLATUS_FIXTURE_PROFILE ??
  mkdtempSync(join(tmpdir(), 'afflatus-ark-controls-'));
app.setPath('userData', profile);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>方舟生成隔离回归</title></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/ark-generation-controls.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 1100,
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
  const text = () => run('document.body.innerText');
  const state = () => run('arkControls.state()');
  const wait = async (source, label) => {
    for (let i = 0; i < 250; i++) {
      if (await run(source)) return;
      await sleep(20);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const has = (text) =>
    wait(`document.body.innerText.includes(${JSON.stringify(text)})`, text);
  const load = async (settings = false) => {
    await win.loadURL(
      `${origin}/${basename(scratch)}/index.html${settings ? '?settings' : ''}`,
    );
    await wait('typeof arkControls !== "undefined"', 'fixture mounted');
    await wait(
      settings
        ? 'arkControls.state().reads === 1'
        : 'arkControls.state().listeners === 1',
      'StrictMode settled once',
    );
  };
  const input = async (selector, value) =>
    run(
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
    );
  const review = async () => {
    const before = (await state()).previews;
    await click('生成视频');
    await wait(
      `arkControls.state().previews === ${before + 1}`,
      'request prepared',
    );
    await run('arkControls.resolvePreview()');
    await has('确认发送到火山方舟中国区');
  };
  let failed = false;
  try {
    await load(true);
    assert.equal((await state()).previews, 0);
    assert.equal((await state()).submits.length, 0);
    await run('arkControls.readConfig()');
    await has('已配置（不回显）');
    assert.equal(await run('document.querySelector("#ark-api-key").value'), '');
    assert.equal(
      await run('document.querySelector("#ark-api-key").type'),
      'password',
    );
    await input('#ark-api-key', 'fixture-write-only-key');
    await run(`{ const b = ${button('保存生成配置')}; b.click(); b.click(); }`);
    assert.equal((await state()).saves.length, 1);
    assert.equal((await state()).saves[0].apiKey, 'fixture-write-only-key');
    await wait(
      'document.querySelector("#ark-api-key").value === ""',
      'submitted key cleared',
    );
    await run('arkControls.saveConfig()');
    await has('没有发送测试请求');
    assert.equal((await state()).previews, 0);
    assert.equal((await state()).submits.length, 0);
    assert.doesNotMatch(await text(), /fixture-write-only-key/);
    console.log(
      'PASS local-only config read, write-only password, one save, and no provider probe',
    );

    await load(true);
    await run('arkControls.corruptConfig(); arkControls.readConfig()');
    await has('云端任务记录损坏');
    await has('云端生成已停用');
    assert.doesNotMatch(await text(), /本机安全存储不可用/);
    assert.equal(await run(`${button('保存生成配置')}.disabled`), true);
    assert.equal(
      await run('document.querySelector("#ark-api-key").matches(":disabled")'),
      true,
    );
    assert.equal(
      await run(
        'document.getElementById("ark-model-seedance-2.0").matches(":disabled")',
      ),
      true,
    );
    await click('保存生成配置');
    assert.equal((await state()).saves.length, 0);
    await run('arkControls.repairConfig()');
    await click('重新读取本机记录');
    await wait('arkControls.state().reads === 2', 'explicit local reread');
    await run('arkControls.readConfig()');
    await has('已配置（不回显）');
    assert.equal(await run(`${button('保存生成配置')}.disabled`), false);
    assert.equal((await state()).previews, 0);
    assert.equal((await state()).submits.length, 0);
    console.log(
      'PASS corrupt records show the exact preservation reason, block mutation, and permit only local reread',
    );

    await load();
    await review();
    const reviewed = await text();
    assert.match(reviewed, /ep-explicit-confirmed/);
    assert.ok(
      reviewed.indexOf('第一段提示词') < reviewed.indexOf('第二段提示词'),
    );
    assert.ok(
      reviewed.indexOf('先发送 B.png') < reviewed.indexOf('后发送 A.png'),
    );
    assert.match(reviewed, /可能产生费用/);
    assert.equal((await state()).submits.length, 0);
    await click('取消');
    await wait('!document.querySelector("dialog")', 'review cancelled');
    assert.equal((await state()).submits.length, 0);
    assert.ok((await state()).events.includes('cancel-preview:preview-0'));
    console.log(
      'PASS exact ordered review and explicit cancellation submit nothing',
    );

    await review();
    await run(
      `{ const b = ${button('确认发送到火山方舟中国区')}; b.click(); b.click(); }`,
    );
    assert.equal((await state()).submits.length, 1);
    await run('arkControls.resolveSubmit()');
    await has('云端排队中');
    assert.doesNotMatch(await text(), /取消云端排队任务/);
    assert.match(await text(), /火山方舟控制台/);
    await click('暂停本地跟踪');
    await has('本地跟踪已暂停');
    assert.equal((await state()).submits.length, 1);
    assert.ok((await state()).events.includes('stop:job-one'));
    await click('恢复结果查询');
    await wait(
      '!arkControls.state().jobs[0].locallyStopped',
      'resumed existing ID',
    );
    await run('arkControls.job("running")');
    await has('运行中的任务不能远程取消');
    assert.doesNotMatch(await text(), /取消云端/);
    console.log(
      'PASS one confirmed submission and local tracking pause never claims remote cancellation',
    );

    await run('arkControls.job("download_failed")');
    await has('重试下载结果');
    await click('重试下载结果');
    await wait(
      'arkControls.state().events.includes("download:job-one")',
      'download retry',
    );
    await run('arkControls.job("save_failed")');
    await has('重试保存候选');
    await click('重试保存候选');
    await wait(
      'arkControls.state().events.includes("save:job-one")',
      'save retry',
    );
    assert.equal((await state()).submits.length, 1);
    await run('arkControls.job("recovery_blocked")');
    await has('重新核对保存结果');
    await click('重新核对保存结果');
    assert.equal((await state()).submits.length, 1);
    await run('arkControls.job("candidate")');
    await has('采纳为新视频卡片');
    assert.equal((await state()).adopts.length, 0);
    await run(
      `{ const b = ${button('采纳为新视频卡片')}; b.click(); b.click(); }`,
    );
    await wait(
      'arkControls.state().adopts.length === 1',
      'one adoption callback',
    );
    assert.equal((await state()).adopts.length, 1);
    await run('arkControls.rejectAdopt()');
    await has('重试采用确认');
    assert.equal(await run(`${button('重试采用确认')}.disabled`), false);
    await click('重试采用确认');
    await wait(
      'arkControls.state().adopts.length === 2',
      'same adoption callback retried',
    );
    assert.equal((await state()).adopts.length, 2);
    await run('arkControls.resolveAdopt()');
    await has('已采纳');
    assert.equal((await state()).submits.length, 1);
    console.log(
      'PASS independent retries and explicit atomic adoption retry never regenerate',
    );

    await load();
    await run('arkControls.job("candidate")');
    await wait(`!!${button('任务与候选（1）')}`, 'committed candidate history');
    await click('任务与候选（1）');
    await has('采纳为新视频卡片');
    await click('采纳为新视频卡片');
    await wait(
      'arkControls.state().adopts.length === 1',
      'adoption sent before lost receipt',
    );
    await run('arkControls.rejectAdopt(true)');
    await has('已采纳');
    await has('重试采用确认');
    assert.equal(await run(`${button('重试采用确认')}.disabled`), false);
    await click('重试采用确认');
    await wait(
      'arkControls.state().adopts.length === 2',
      'committed receipt retried',
    );
    assert.deepEqual((await state()).adopts, ['job-one', 'job-one']);
    await run('arkControls.resolveAdopt()');
    await wait(`!${button('重试采用确认')}`, 'local receipt reconciled');
    assert.equal((await state()).submits.length, 0);
    console.log(
      'PASS lost adopted receipt retains dedicated retry for the exact job, even when history says adopted',
    );

    await load();
    await run('arkControls.job("candidate")');
    await wait(`!!${button('任务与候选（1）')}`, 'candidate history available');
    await click('任务与候选（1）');
    await has('采纳为新视频卡片');
    await run('arkControls.holdFlush()');
    await click('采纳为新视频卡片');
    await run('arkControls.captureLeave()');
    await sleep(60);
    assert.equal((await state()).adopts.length, 0);
    assert.deepEqual((await state()).leaves, []);
    await run('arkControls.releaseFlush()');
    await wait(
      'arkControls.state().adopts.length === 1',
      'adoption starts after input flush',
    );
    assert.deepEqual((await state()).leaves, []);
    await run('arkControls.resolveAdopt()');
    await wait(
      'arkControls.state().leaves.length === 1',
      'native leave observes full adoption',
    );
    assert.deepEqual((await state()).leaves, [true]);
    console.log(
      'PASS native leave captures preflush and waits for authoritative adoption completion',
    );

    await load();
    await run('arkControls.job("candidate")');
    await wait(
      `!!${button('任务与候选（1）')}`,
      'candidate history for interrupted flush',
    );
    await click('任务与候选（1）');
    await has('采纳为新视频卡片');
    await run('arkControls.holdFlush()');
    await click('采纳为新视频卡片');
    await run('arkControls.captureLeave(); arkControls.close()');
    await has('已关闭');
    await run('arkControls.releaseFlush()');
    await wait(
      'arkControls.state().leaves.length === 1',
      'interrupted flush settled',
    );
    assert.equal((await state()).adopts.length, 0);
    assert.deepEqual((await state()).leaves, [false]);
    console.log(
      'PASS unmount during input flush cannot adopt into a stale or closed editor',
    );

    await load();
    await review();
    await run('arkControls.change()');
    await has('原确认已失效');
    assert.equal((await state()).submits.length, 0);
    assert.equal(await run(`!!${button('确认发送到火山方舟中国区')}`), false);
    await click('返回编辑');
    await wait('!document.querySelector("dialog")', 'stale review dismissed');
    await click('生成视频');
    await wait(
      'arkControls.state().previews === 2',
      'delayed preview requested',
    );
    await click('关闭');
    await wait('!document.querySelector("dialog")', 'loading preview closed');
    await run('arkControls.resolvePreview()');
    await sleep(80);
    assert.equal(await run('!!document.querySelector("dialog")'), false);
    assert.equal((await state()).submits.length, 0);
    assert.ok((await state()).events.includes('cancel-preview:preview-1'));
    console.log(
      'PASS stale groups invalidate approval; late preview cannot reopen or submit',
    );

    await click('生成视频');
    await wait(
      'arkControls.state().previews === 3',
      'unsupported input preview',
    );
    await run(
      'arkControls.rejectPreview("本地视频参考尚未配置受支持的上传映射，不能提交")',
    );
    await has('本地视频参考尚未配置');
    assert.equal((await state()).submits.length, 0);
    await click('打开设置 → 云端生成');
    assert.equal((await state()).settingsOpens, 1);
    await wait(
      '!document.querySelector("dialog")',
      'settings route dismissed review',
    );
    console.log(
      'PASS unsupported local media fails preflight with a clear Settings path',
    );

    await run('arkControls.job("submission_unknown"); arkControls.close()');
    await has('已关闭');
    await run('arkControls.open()');
    await wait(
      'arkControls.state().listeners === 1',
      'reopened group listening once',
    );
    await wait(`!!${button('任务与候选（1）')}`, 'history button refreshed');
    await click('任务与候选（1）');
    await has('提交结果不确定');
    assert.equal((await state()).submits.length, 0);
    await click('核对后新建生成任务…');
    await wait(
      'arkControls.state().previews === 4',
      'new task explicit review',
    );
    await run('arkControls.resolvePreview()');
    await has('之前的提交结果不确定');
    assert.equal(
      await run(`${button('确认发送到火山方舟中国区')}.disabled`),
      true,
    );
    await run('document.querySelector("dialog input[type=checkbox]").click()');
    await click('确认发送到火山方舟中国区');
    assert.equal((await state()).submits.length, 1);
    await run('arkControls.resolveSubmit("submission_unknown")');
    await has('没有可靠的提交回执');
    await run('arkControls.close()');
    await has('已关闭');
    await run('arkControls.open()');
    await wait('arkControls.state().listeners === 1', 'second reopen');
    await wait(`!!${button('任务与候选（1）')}`, 'history button refreshed');
    await click('任务与候选（1）');
    await has('提交结果不确定');
    assert.equal((await state()).submits.length, 1);
    console.log(
      'PASS unknown submission survives reopen with no automatic resubmit; explicit duplicate-charge acknowledgement required',
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    failed = true;
    console.error(error);
  } finally {
    win.destroy();
    if (!process.env.AFFLATUS_FIXTURE_SCRATCH)
      rmSync(scratch, { recursive: true, force: true });
    if (!process.env.AFFLATUS_FIXTURE_PROFILE)
      rmSync(profile, { recursive: true, force: true });
    app.exit(failed ? 1 : 0);
  }
});
