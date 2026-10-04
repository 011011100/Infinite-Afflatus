// Actual recovery guards and editor history, with an atomic typed native-read fixture.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow } = require('electron');
const origin = process.env.AFFLATUS_FIXTURE_ORIGIN;
if (!origin)
  throw new Error(
    'Run pnpm test:browser canvas-recovery with the isolated fixture runner',
  );
const root = resolve(__dirname, '../..');
const scratch =
  process.env.AFFLATUS_FIXTURE_SCRATCH ??
  mkdtempSync(join(root, 'src/renderer/.canvas-recovery-'));
const profile =
  process.env.AFFLATUS_FIXTURE_PROFILE ??
  mkdtempSync(join(tmpdir(), 'afflatus-canvas-recovery-'));
app.setPath('userData', profile);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>项目恢复基线回归</title></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/canvas-recovery.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  const run = (source) => win.webContents.executeJavaScript(source);
  const errors = [];
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const wait = async (source, label) => {
    for (let i = 0; i < 200; i++) {
      assert.deepEqual(errors, [], label);
      if (await run(source)) return;
      await sleep(20);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const read = (id) =>
    run(`JSON.parse(document.querySelector('#${id}').textContent)`);
  const click = (id) => run(`document.querySelector('#${id}').click()`);
  const state = () => run('canvasRecoveryControls.state()');
  const load = async (existing = false) => {
    await win.loadURL(
      `${origin}/${basename(scratch)}/index.html${existing ? '?existing' : ''}`,
    );
    await wait(`!!document.querySelector('#open')`, 'fixture loaded');
    await click('open');
    await wait(
      `!!document.querySelector('#edit-shot') && !document.querySelector('#edit-shot').disabled`,
      'original editor loaded',
    );
    const instance = await run(
      `document.querySelector('#editor').dataset.instance`,
    );
    await click('edit-shot');
    await wait(
      `canvasRecoveryControls.state().workspace.shots[0].name === '保留的镜头编辑'`,
      'shot edit saved with undo history',
    );
    if (existing) {
      await click('edit-canvas');
      await wait(
        `JSON.parse(document.querySelector('#editor-state').textContent).canvas.cards[0].position.x===50`,
        'canvas edit saved with undo history',
      );
    }
    return { instance, baseline: await read('editor-state') };
  };
  const lose = async (count) => {
    await run(`canvasRecoveryControls.saveReferencesThenLoseProject(${count})`);
    await wait(
      `JSON.parse(document.querySelector('#session-state').textContent).unavailable?.retrying===false`,
      'offline project preserves old baseline',
    );
  };
  const retry = async (variant) => {
    await run(`canvasRecoveryControls.restore(${JSON.stringify(variant)})`);
    await run(`(() => {
      const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='重试读取项目');
      if (!button || button.disabled || button.closest('[inert]')) throw new Error('Recovery button unavailable');
      button.click();
    })()`);
  };
  const assertSameEditor = async (instance) => {
    assert.equal(
      await run(`document.querySelector('#editor').dataset.instance`),
      instance,
    );
    assert.equal((await read('editor-state')).shotUndo, true);
    assert.equal((await read('editor-state')).shotName, '保留的镜头编辑');
  };
  let failed = false;
  try {
    const first = await load();
    assert.deepEqual(first.baseline.assets, []);
    await lose(1);
    assert.deepEqual((await read('editor-state')).assets, []);
    const beforeRecovery = (await state()).recoveryReads;
    await retry('original');
    await wait(
      `!document.querySelector('[data-project-unavailable]')`,
      'acknowledged reference safely extends the unrefreshed baseline',
    );
    await wait(
      `JSON.parse(document.querySelector('#editor-state').textContent).assets.length===1`,
      'recovered asset snapshot reaches the original editor',
    );
    assert.ok((await state()).recoveryReads > beforeRecovery);
    await assertSameEditor(first.instance);
    await click('undo-shot');
    await wait(
      `canvasRecoveryControls.state().workspace.shots[0].name==='原镜头'`,
      'original shot undo remains usable',
    );
    console.log(
      'PASS a saved reference whose notification missed the UI baseline recovers through the atomic native view and preserves the editor instance and working undo',
    );

    const older = await load();
    await lose(2);
    const beforeMissing = await state();
    await retry('missing-second');
    await wait(
      `JSON.parse(document.querySelector('#session-state').textContent).unavailable?.conflict===true`,
      'older database missing a second acknowledged reference remains blocked',
    );
    assert.deepEqual((await read('editor-state')).assets, []);
    assert.equal((await state()).writes, beforeMissing.writes);
    assert.equal((await state()).remote.assets.length, 1);
    await assertSameEditor(older.instance);
    await retry('original');
    await wait(
      `!document.querySelector('[data-project-unavailable]') && JSON.parse(document.querySelector('#editor-state').textContent).assets.length===2`,
      'only the complete original reference set resumes',
    );
    await assertSameEditor(older.instance);
    console.log(
      'PASS an empty UI baseline cannot authorize an older database missing a saved reference; conflict writes nothing and the complete original later recovers',
    );

    for (const variant of ['changed-asset', 'changed-canvas']) {
      const original = await load(true);
      assert.equal(original.baseline.canvasUndo, true);
      await lose(1);
      const before = await state();
      await retry(variant);
      await wait(
        `JSON.parse(document.querySelector('#session-state').textContent).unavailable?.conflict===true`,
        `${variant} cannot be authorized by a valid new reference`,
      );
      const blocked = await read('editor-state');
      assert.deepEqual(blocked.assets, original.baseline.assets);
      assert.deepEqual(blocked.canvas, original.baseline.canvas);
      assert.equal(blocked.canvasUndo, true);
      assert.equal((await state()).writes, before.writes);
      await assertSameEditor(original.instance);
      await retry('original');
      await wait(
        `!document.querySelector('[data-project-unavailable]')`,
        'original baseline recovers after rejecting external edits',
      );
      await click('undo-canvas');
      await wait(
        `canvasRecoveryControls.state().remote.canvas.cards[0].position.x===0`,
        'canvas undo survives conflict and recovery',
      );
      console.log(
        `PASS ${variant} stays blocked despite valid import proof; original asset/canvas history remains intact and undo works after exact recovery`,
      );
    }
    assert.deepEqual(errors, []);
  } catch (error) {
    failed = true;
    console.error(error);
    console.error(errors);
    console.error(
      await run('document.body.innerText').catch(() => 'Renderer unavailable'),
    );
  } finally {
    try {
      win.destroy();
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
