// Real React/React Flow with delayed intake and independent leave tokens.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = resolve(__dirname, '../..');
const scratch =
  process.env.AFFLATUS_FIXTURE_SCRATCH ??
  mkdtempSync(join(root, 'src/renderer/.reference-controls-'));
const profile =
  process.env.AFFLATUS_FIXTURE_PROFILE ??
  mkdtempSync(join(tmpdir(), 'afflatus-reference-controls-'));
app.setPath('userData', profile);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/reference-import-controls.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { backgroundThrottling: false, offscreen: true },
  });
  const run = (code) => win.webContents.executeJavaScript(code);
  const errors = [];
  let loadCount = 0;
  let painting = false;
  const paint = setInterval(async () => {
    if (painting || win.webContents.isDestroyed()) return;
    painting = true;
    try {
      await win.webContents.capturePage();
    } catch {
      // A hidden macOS window may not have a compositor surface during navigation.
    } finally {
      painting = false;
    }
  }, 32);
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error')
      errors.push(`page ${loadCount}: ${details.message}`);
  });
  const waitFor = async (code, description) => {
    for (let i = 0; i < 200; i++) {
      if (await run(code)) return;
      await sleep(20);
    }
    throw new Error(`Timed out: ${description}`);
  };
  const button = (label) =>
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
  const click = (label) => run(`${button(label)}.click()`);
  const status =
    'document.querySelector("section[aria-label=参考素材导入]")?.textContent ?? ""';
  const state = () => run('importControls.state()');
  const load = async (query = '') => {
    loadCount++;
    await win.loadURL(
      `${process.env.AFFLATUS_FIXTURE_ORIGIN ?? 'http://127.0.0.1:5173'}/${basename(scratch)}/index.html${query}`,
    );
    if (!query.includes('reject')) {
      await waitFor(`!!${button('素材画布')}`, 'project loaded');
      await click('素材画布');
    }
    await waitFor(`!!${button('导入素材')}`, 'material editor');
    // Let the real page opening transition and initial Flow measurements settle.
    await sleep(250);
  };
  const start = async (count = 1) => {
    await click('导入素材');
    await waitFor(
      `importControls.state().batches.length === ${count}`,
      'native import started',
    );
  };
  const assertSavedReference = async () => {
    await waitFor(
      'importControls.state().workspace.shots[0].nodes.some(n => n.assetId === "complete-reference")',
      'completed reference saved',
    );
    const value = await state();
    const completed = value.events.findIndex((event) =>
      event.startsWith('complete:'),
    );
    const saved = value.events.indexOf('save:1');
    assert.ok(
      completed >= 0 && saved > completed,
      'intake settles and adds references before project saving',
    );
  };
  let failed = false;
  try {
    await load();
    await run('document.querySelector("#same-turn").click()');
    await waitFor(
      'importControls.sameTurnResult === true',
      'same-event start and cancel settle',
    );
    assert.deepEqual((await state()).batches, []);
    console.log(
      'PASS a same-event cancellation prevents the deferred import IPC from starting a batch',
    );

    await load();
    await start();
    await run('importControls.progress(64 * 1024 ** 2)');
    await waitFor(
      `(${status}).includes('64.0 MB') && (${status}).includes('2 / 3')`,
      'actual bytes and count',
    );
    await sleep(100);
    assert.match(await run(status), /64\.0 MB/);
    assert.doesNotMatch(await run(status), /%/);
    await click('取消导入');
    await waitFor(`(${status}).includes('正在停止导入')`, 'stopping state');
    await run('importControls.progress(65 * 1024 ** 2)');
    assert.match(await run(status), /正在停止导入/);
    assert.equal(await run(`${button('导入素材')}.disabled`), true);
    await run('importControls.complete()');
    await waitFor(`!${button('导入素材')}.disabled`, 'cancel settled');
    assert.match(await run(status), /已添加 1 个素材，2 个未完成/);
    await assertSavedReference();
    await start(2);
    await run('importControls.progress(12 * 1024 ** 2)');
    await waitFor(`(${status}).includes('12.0 MB')`, 'new batch progress');
    await run('importControls.progress(999, 0, "cancelled")');
    assert.match(await run(status), /缓慢文件-2.mp4/);
    assert.doesNotMatch(await run(status), /999 B/);
    await click('取消导入');
    await run('importControls.complete([])');
    await waitFor(
      `!${button('导入素材')}.disabled`,
      'second cancellation settled',
    );
    console.log(
      'PASS actual byte/count progress, explicit cancellation preserves completed references, and old progress cannot contaminate a new batch',
    );

    await load();
    await start();
    await click('返回主画布');
    await waitFor(
      `(${status}).includes('正在停止导入')`,
      'return stops import',
    );
    assert.equal(
      await run('!!document.querySelector("section[aria-label$=素材子画布]")'),
      true,
    );
    await run('importControls.complete()');
    await waitFor(
      '!document.querySelector("section[aria-label$=素材子画布]")',
      'return waits for import and save',
    );
    await assertSavedReference();
    assert.deepEqual((await state()).pauses, []);
    console.log(
      'PASS material return stops intake, adds completed references, saves, and releases its pause before leaving',
    );

    for (const leave of ['home', 'native']) {
      await load();
      await start();
      await run(`void importControls.${leave}()`);
      await waitFor(
        'importControls.state().batches[0].cancelled',
        `${leave} cancels intake`,
      );
      await sleep(80);
      assert.equal(
        await run(
          leave === 'home'
            ? 'importControls.homeResult'
            : 'importControls.nativeResults[0] ?? null',
        ),
        null,
      );
      await run('importControls.complete()');
      await waitFor(
        leave === 'home'
          ? 'importControls.homeResult === true'
          : 'importControls.nativeResults[0] === true',
        `${leave} saved`,
      );
      await assertSavedReference();
      assert.equal((await state()).pauses.length, leave === 'home' ? 0 : 1);
      console.log(
        `PASS ${leave} waits for completed references before saving; pause lifetime follows navigation or native shutdown`,
      );
    }

    await load();
    await start();
    await run('importControls.failSaving(true); void importControls.home()');
    await waitFor(
      'importControls.state().batches[0].cancelled',
      'failed leave cancels intake',
    );
    await run('importControls.complete()');
    await waitFor(
      'importControls.homeResult === false',
      'save failure retains page',
    );
    assert.equal(await run('!!document.querySelector("#home")'), false);
    assert.deepEqual((await state()).pauses, []);
    await run('importControls.failSaving(false); void importControls.home()');
    await waitFor(
      'importControls.homeResult === true',
      'retry saves retained reference',
    );
    await assertSavedReference();
    console.log(
      'PASS failed project saving retains the completed-reference draft and releases the pause; retry succeeds',
    );

    await load();
    await start();
    await run('importControls.holdSave(); void importControls.native()');
    await waitFor(
      'importControls.state().pauses.length === 1',
      'old close pause',
    );
    await run('importControls.timeout(); void importControls.native()');
    await waitFor(
      'importControls.state().pauses.length === 2',
      'retry pause while intake still stopping',
    );
    await run('importControls.complete()');
    await waitFor(
      'importControls.state().events.includes("save:1")',
      'new close saving',
    );
    assert.equal(
      (await state()).pauses.length,
      1,
      'late old token is released without unlocking the new pause',
    );
    await run('importControls.releaseSave()');
    await waitFor(
      'importControls.nativeResults.length === 2',
      'both close replies',
    );
    assert.deepEqual(await run('importControls.nativeResults'), [false, true]);
    assert.equal((await state()).pauses.length, 1);
    console.log(
      'PASS timeout retries retain only the new independent pause; late old reply never authorizes native close',
    );

    await load();
    await click('文本');
    await waitFor(
      '!!document.querySelector("textarea[aria-label=文本卡片内容]")',
      'new text',
    );
    await run(`(() => {
      const input = document.querySelector('textarea[aria-label=文本卡片内容]');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '断盘前的文字');
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new FocusEvent('focusout', {bubbles:true}));
    })()`);
    await waitFor(
      'importControls.state().workspace.shots[0].nodes.some(n => n.text === "断盘前的文字")',
      'text saved before intake',
    );
    await start();
    await run('importControls.blockProject(true)');
    await waitFor(
      'document.querySelector("textarea[aria-label=文本卡片内容]").disabled',
      'project editor frozen',
    );
    await run('importControls.complete()');
    await waitFor(
      'importControls.state().drafts.some(d => d.workspace.shots[0].nodes.some(n => n.assetId === "complete-reference"))',
      'independent draft retains completed reference',
    );
    const protectedDraft = (await state()).drafts.find((d) =>
      d.workspace.shots[0].nodes.some(
        (n) => n.assetId === 'complete-reference',
      ),
    );
    assert.equal(
      protectedDraft.workspace.shots[0].nodes.filter(
        (n) => n.assetId === 'complete-reference',
      ).length,
      1,
    );
    assert.equal(
      protectedDraft.workspace.shots[0].nodes.find((n) => n.type === 'text')
        .text,
      '断盘前的文字',
    );
    assert.equal(
      (await state()).workspace.shots[0].nodes.some(
        (n) => n.assetId === 'complete-reference',
      ),
      false,
    );
    assert.equal(await run(`${button('导入素材')}.disabled`), true);
    await run('void importControls.home()');
    await waitFor(
      'importControls.homeResult === false',
      'unavailable project cannot leave with retained references',
    );
    assert.equal(await run('!!document.querySelector("#home")'), false);
    assert.deepEqual((await state()).pauses, []);
    await run('importControls.blockProject(false)');
    await waitFor(
      'importControls.state().workspace.shots[0].nodes.some(n => n.assetId === "complete-reference")',
      'same project resumes saving',
    );
    const undo =
      'section[aria-label$="素材子画布"] > header button[aria-label="撤销"]';
    const redo =
      'section[aria-label$="素材子画布"] > header button[aria-label="重做"]';
    await waitFor(
      `!document.querySelector(${JSON.stringify(undo)}).disabled`,
      'history still available',
    );
    await run(`document.querySelector(${JSON.stringify(undo)}).click()`);
    await waitFor(
      '!importControls.state().workspace.shots[0].nodes.some(n => n.assetId === "complete-reference")',
      'undo removes only appended references',
    );
    assert.equal(
      (await state()).workspace.shots[0].nodes.find((n) => n.type === 'text')
        .text,
      '断盘前的文字',
    );
    await run(`document.querySelector(${JSON.stringify(undo)}).click()`);
    await waitFor(
      'importControls.state().workspace.shots[0].nodes.find(n => n.type === "text")?.text === ""',
      'pre-import text history retained',
    );
    await run(`document.querySelector(${JSON.stringify(redo)}).click()`);
    await run(`document.querySelector(${JSON.stringify(redo)}).click()`);
    await waitFor(
      'importControls.state().workspace.shots[0].nodes.some(n => n.assetId === "complete-reference")',
      'redo restores original append',
    );
    assert.equal(
      (await state()).workspace.shots[0].nodes.filter(
        (n) => n.assetId === 'complete-reference',
      ).length,
      1,
    );
    assert.equal(
      (await state()).workspace.shots[0].nodes.find((n) => n.type === 'text')
        .text,
      '断盘前的文字',
    );
    await run('void importControls.home()');
    await waitFor(
      'importControls.homeResult === true',
      'explicit retry leaves after original project saves',
    );
    console.log(
      'PASS project loss during import retains completed IDs in the independent draft, blocks leave, and resumes once without losing text or undo history',
    );

    await load('?draft=1');
    await start();
    await click('恢复镜头草稿');
    await waitFor(
      'document.body.innerText.includes("素材导入尚未结束")',
      'recovery rejects an active import',
    );
    assert.equal((await state()).recoveryCalls, 0);
    await run('importControls.complete()');
    await assertSavedReference();
    assert.equal(
      (await state()).workspace.shots[0].nodes.some(
        (n) => n.text === '旧恢复内容',
      ),
      false,
    );
    console.log(
      'PASS an active import explicitly prevents old-draft recovery from replacing its original target shot',
    );

    await load('?reject=1');
    await start();
    await run('importControls.complete()');
    await waitFor(
      `!!${button('重试添加素材')}`,
      'rejected target keeps a retry entry',
    );
    assert.equal(await run(`!!${button('关闭提示')}`), false);
    assert.doesNotMatch(await run(status), /已添加 1/);
    assert.equal((await state()).events.includes('target:finished'), false);
    await run('void importControls.home()');
    await waitFor(
      'importControls.homeResult === false',
      'unaccepted IDs veto leave',
    );
    await click('重试添加素材');
    await waitFor(
      'importControls.state().appendAttempts.length === 2',
      'first retry rejected',
    );
    assert.equal(await run(`!!${button('关闭提示')}`), false);
    assert.equal(await run(`!!${button('重试添加素材')}`), true);
    assert.deepEqual(
      (await state()).appendAttempts[0],
      (await state()).appendAttempts[1],
    );
    await run('importControls.allowAppend()');
    await click('重试添加素材');
    await waitFor(
      `!${button('导入素材')}.disabled`,
      'accepted retry unlocks import',
    );
    const attempts = (await state()).appendAttempts;
    assert.equal(attempts.length, 3);
    assert.deepEqual(attempts[0], attempts[2]);
    assert.equal(
      (await state()).batches.length,
      1,
      'retry never starts another native import',
    );
    assert.equal(
      (await state()).events.filter((event) => event === 'target:finished')
        .length,
      1,
    );
    assert.equal(
      await run(
        'document.querySelectorAll(".react-flow__node-material").length',
      ),
      1,
    );
    await run('void importControls.home()');
    await waitFor(
      'importControls.homeResult === true',
      'accepted IDs release leave',
    );
    console.log(
      'PASS rejected target retains IDs and a non-dismissible retry entry, reuses node identities, and finishes only after acceptance',
    );

    assert.deepEqual(errors, []);
  } catch (error) {
    failed = true;
    console.error(error);
    console.error(errors);
    console.error(await run('document.body.innerText'));
  } finally {
    clearInterval(paint);
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
