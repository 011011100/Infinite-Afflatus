// Renderer integration against the existing Vite server; no user project or process is touched.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = resolve(__dirname, '../..');
const scratch = mkdtempSync(join(root, 'src/renderer/.save-lifecycle-test-'));
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/save-lifecycle.fixture.tsx"></script></body></html>`,
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
  const load = async () => {
    await win.loadURL(`http://127.0.0.1:5173/${basename(scratch)}/index.html`);
    for (let i = 0; i < 50; i++) {
      if (
        await run(
          '!!document.querySelector("#edit") && !document.querySelector("#edit").disabled',
        )
      )
        return;
      await sleep(100);
    }
    throw new Error('Lifecycle fixture failed to load');
  };
  let failed = false;
  try {
    await load();
    await run(
      'document.querySelector("#edit").click(); document.querySelector("#home").click();',
    );
    await sleep(180);
    assert.equal(
      await run('document.querySelector("#page").textContent'),
      'home',
    );
    assert.deepEqual(
      await run('JSON.parse(document.querySelector("#result").textContent)'),
      { name: 'unsaved draft', writes: 1 },
    );
    console.log(
      'PASS returning home flushes the last edit before the 350 ms debounce',
    );

    await load();
    await run(
      'document.querySelector("#hold-gate").click(); document.querySelector("#edit").click(); document.querySelector("#home").click();',
    );
    await sleep(180);
    assert.equal(
      await run('document.querySelector("#page").textContent'),
      'home',
    );
    assert.equal(
      await run(
        'JSON.parse(document.querySelector("#result").textContent).name',
      ),
      'unsaved draft',
    );
    console.log(
      'PASS navigation cancels gated media checks and package copying before flushing drafts',
    );

    await load();
    await run(
      'document.querySelector("#fail").click(); document.querySelector("#edit").click(); document.querySelector("#home").click();',
    );
    await sleep(180);
    assert.equal(
      await run('document.querySelector("#page").textContent'),
      'editor',
    );
    assert.equal(
      await run('document.querySelector("#draft").textContent'),
      'unsaved draft',
    );
    assert.equal(
      await run('document.body.textContent.includes("仍有修改未保存")'),
      true,
    );
    assert.equal(await run('document.querySelector("#root").inert'), false);
    await run(
      'document.querySelector("#recover").click(); document.querySelector("#home").click();',
    );
    await sleep(180);
    assert.equal(
      await run('document.querySelector("#page").textContent'),
      'home',
    );
    assert.equal(
      await run(
        'JSON.parse(document.querySelector("#result").textContent).name',
      ),
      'unsaved draft',
    );
    console.log(
      'PASS failed navigation retains the draft and page, then succeeds after recovery',
    );

    await load();
    await run(
      'document.querySelector("#edit").click(); document.querySelector("#native-close").click();',
    );
    await sleep(180);
    assert.deepEqual(
      await run('JSON.parse(document.querySelector("#result").textContent)'),
      { saved: true, name: 'unsaved draft' },
    );
    assert.equal(await run('document.querySelector("#root").inert'), true);
    console.log(
      'PASS native close acknowledgement follows saving and leaves editor frozen for shutdown',
    );

    await load();
    await run(
      'document.querySelector("#hold-save").click(); document.querySelector("#edit").click(); document.querySelector("#native-close").click();',
    );
    await sleep(100);
    assert.equal(await run('document.querySelector("#root").inert'), true);
    await run('document.querySelector("#timeout-close").click();');
    await sleep(20);
    assert.equal(await run('document.querySelector("#root").inert'), false);
    await run(
      'document.querySelector("#edit-again").click(); document.querySelector("#native-close").click();',
    );
    await sleep(20);
    assert.equal(
      await run('document.querySelector("#root").inert'),
      true,
      'retry must freeze editing even while the old flush is pending',
    );
    await run('document.querySelector("#release-save").click();');
    await sleep(150);
    assert.deepEqual(
      await run(
        'JSON.parse(document.querySelector("#native-results").textContent)',
      ),
      [
        { request: 1, saved: false, name: 'unsaved draft' },
        { request: 2, saved: true, name: 'draft after timeout' },
      ],
    );
    assert.equal(await run('document.querySelector("#root").inert'), true);
    console.log(
      'PASS timeout retry freezes anew, rescans editors and never authorizes close from the old epoch',
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    failed = true;
    console.error(error);
    console.error(errors);
  } finally {
    win.destroy();
    rmSync(scratch, { recursive: true, force: true });
    app.exit(failed ? 1 : 0);
  }
});
