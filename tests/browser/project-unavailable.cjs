const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = resolve(__dirname, '../..');
const scratch = mkdtempSync(join(root, 'src/renderer/.project-unavailable-'));
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/project-unavailable.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.once('will-quit', () => rmSync(scratch, { recursive: true, force: true }));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  const run = (code) => win.webContents.executeJavaScript(code);
  const errors = [];
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const click = (id) => run(`document.querySelector('#${id}').click()`);
  const read = (id) =>
    run(`JSON.parse(document.querySelector('#${id}').textContent)`);
  const until = async (code) => {
    for (let i = 0; i < 80; i++) {
      if (await run(code)) return;
      await sleep(40);
    }
    throw new Error(`Timed out: ${code}`);
  };
  const load = async () => {
    await win.loadURL(`http://127.0.0.1:5173/${basename(scratch)}/index.html`);
    await until(`!!document.querySelector('#open')`);
    await click('open');
    await until(
      `!!document.querySelector('#shot-edit') && !document.querySelector('#shot-edit').disabled`,
    );
  };
  let failed = false;
  try {
    await load();
    const instance = await run(
      `document.querySelector('#editor').dataset.instance`,
    );
    await click('canvas-edit');
    await until(
      `JSON.parse(document.querySelector('#editor-state').textContent).x===50`,
    );
    await click('offline-silent');
    await click('canvas-edit');
    await until(
      `!!document.querySelector('#editor [data-project-unavailable]')`,
    );
    assert.equal((await read('editor-state')).canUndo, true);
    await click('global-update');
    await until(
      `JSON.parse(document.querySelector('#session-state').textContent).root==='/still-live'`,
    );
    await click('restore');
    await click('retry');
    await until(
      `!JSON.parse(document.querySelector('#session-state').textContent).unavailable`,
    );
    assert.equal(
      await run(`document.querySelector('#editor').dataset.instance`),
      instance,
    );
    await click('canvas-undo');
    await until(
      `JSON.parse(document.querySelector('#editor-state').textContent).x===0`,
    );
    console.log(
      'PASS failed project writes pause editing, preserve canvas history and keep global status live; exact recovery retains the editor instance and undo',
    );

    await load();
    await run(
      `document.querySelector('#shot-edit').click();document.querySelector('#offline-silent').click();document.querySelector('#home').click();`,
    );
    await until(
      `JSON.parse(document.querySelector('#session-state').textContent).saved===false`,
    );
    assert.equal((await read('editor-state')).name, '未保存镜头输入');
    assert.equal((await read('editor-state')).shotUndo, true);
    await click('settings');
    await until(`!!document.querySelector('dialog[open]')`);
    await run(
      `Array.from(document.querySelectorAll('dialog button')).find(button=>button.textContent.includes('打开文件夹')).click()`,
    );
    await sleep(80);
    await click('stats-refresh');
    assert.equal((await read('stats')).revealed, 1);
    await run(
      `document.querySelector('dialog button[aria-label="关闭"]').click()`,
    );
    await sleep(200);
    await click('restore');
    await click('retry');
    await until(
      `!JSON.parse(document.querySelector('#session-state').textContent).unavailable`,
    );
    await sleep(450);
    await click('stats-refresh');
    assert.equal(
      (await read('stats')).workspace.shots[0].name,
      '未保存镜头输入',
    );
    await click('shot-undo');
    await until(
      `JSON.parse(document.querySelector('#editor-state').textContent).name==='原镜头'`,
    );
    console.log(
      'PASS an unsaved shot survives failed leave and exact recovery; settings reveal the folder while drafts are blocked, and shot undo is preserved',
    );

    await load();
    await run(
      `document.querySelector('button[aria-label="重命名镜头名称"]').click()`,
    );
    await until(`!!document.querySelector('input[aria-label="镜头名称"]')`);
    await win.webContents.insertText('未提交名称');
    await click('offline');
    await until(
      `document.querySelector('input[aria-label="镜头名称"]')?.readOnly===true`,
    );
    await click('home');
    await sleep(80);
    assert.equal((await read('session-state')).saved, false);
    assert.equal(
      await run(`document.querySelector('input[aria-label="镜头名称"]').value`),
      '未提交名称',
    );
    await click('restore');
    await click('retry');
    await until(
      `!JSON.parse(document.querySelector('#session-state').textContent).unavailable`,
    );
    await click('home');
    await until(`!document.querySelector('#editor')`);
    await click('stats-refresh');
    assert.equal((await read('stats')).workspace.shots[0].name, '未提交名称');
    console.log(
      'PASS a name still inside its original input stays read-only and blocks leave while offline, then flushes after recovery',
    );

    for (const replacement of ['different-db', 'different-workspace']) {
      await load();
      await click('offline');
      await until(
        `!!JSON.parse(document.querySelector('#session-state').textContent).unavailable`,
      );
      await click(replacement);
      await click('retry');
      await until(
        `JSON.parse(document.querySelector('#session-state').textContent).unavailable?.conflict===true`,
      );
      assert.equal((await read('editor-state')).x, 0);
      assert.equal((await read('editor-state')).name, '原镜头');
    }
    console.log(
      'PASS a same-ID replacement with different canvas contents or workspace revision stays blocked without replacing drafts',
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    failed = true;
    console.error(error);
    console.error(errors);
    console.error(await run('document.body.innerText'));
  } finally {
    win.destroy();
    app.exit(failed ? 1 : 0);
  }
});
