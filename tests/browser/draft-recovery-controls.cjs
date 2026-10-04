// Real React/React Flow with deferred native replies. Uses an existing fixture Vite server.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = resolve(__dirname, '../..');
const scratch = mkdtempSync(join(root, 'src/renderer/.draft-controls-'));
const profile = mkdtempSync(join(tmpdir(), 'afflatus-draft-controls-'));
app.setPath('userData', profile);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/draft-recovery-controls.fixture.tsx"></script></body></html>`,
);
app.once('will-quit', () => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { backgroundThrottling: false },
  });
  const run = (code) => win.webContents.executeJavaScript(code);
  const errors = [];
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const waitFor = async (code, description) => {
    for (let i = 0; i < 150; i++) {
      if (await run(code)) return;
      await sleep(20);
    }
    throw new Error(`Timed out: ${description}`);
  };
  const button = (label) =>
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
  const click = (label) => run(`${button(label)}.click()`);
  const load = async () => {
    await win.loadURL(`http://127.0.0.1:5173/${basename(scratch)}/index.html`);
    await waitFor(
      `${button('恢复镜头草稿')} && !${button('恢复镜头草稿')}.disabled && document.querySelectorAll('[data-id^="shot:"]').length === 2`,
      'fixture',
    );
  };
  const finish = async () => {
    await run(
      'recoveryControls.commit(); recoveryControls.reply(); recoveryControls.refresh();',
    );
    await waitFor(
      'document.querySelector("main")?.getAttribute("aria-busy") === "false"',
      'recovery UI settled',
    );
  };
  let failed = false;
  try {
    await load();
    await run(
      `const oldOpen=${button('素材画布')}; const oldCreate=${button('新建镜头')}; ${button('恢复镜头草稿')}.click(); oldOpen.click(); oldCreate.click();`,
    );
    await waitFor(
      `${button('素材画布')}.disabled && ${button('新建镜头')}.disabled`,
      'entry controls disabled',
    );
    assert.equal(
      await run('!!document.querySelector("section[aria-label$=素材子画布]")'),
      false,
    );
    assert.equal(
      await run(`document.querySelectorAll('[data-id^="shot:"]').length`),
      2,
    );
    await run('recoveryControls.commit()');
    await waitFor(
      'recoveryControls.state().published',
      'database committed before IPC reply',
    );
    assert.equal(await run(`${button('素材画布')}.disabled`), true);
    await run('recoveryControls.reply()');
    await sleep(80);
    assert.equal(await run(`${button('素材画布')}.disabled`), true);
    await run('recoveryControls.refresh()');
    await waitFor(
      `!${button('素材画布')}.disabled`,
      'entry unlocked after complete recovery',
    );
    await click('素材画布');
    await waitFor(
      'document.querySelector("textarea[aria-label=文本卡片内容]")?.value === "恢复后的完整文字"',
      'recovered content remains open',
    );
    await sleep(100);
    assert.equal(
      await run('!!document.querySelector("section[aria-label$=素材子画布]")'),
      true,
    );
    console.log(
      'PASS same-turn stale card/create callbacks cannot enter during recovery; after reply and refresh the recovered text stays visible',
    );

    await load();
    await click('素材画布');
    await waitFor(
      '!!document.querySelector("textarea[aria-label=文本卡片内容]")',
      'original material editor',
    );
    await click('恢复镜头草稿');
    await waitFor(
      `${button('返回主画布')}.disabled`,
      'material return disabled',
    );
    await click('返回主画布');
    await finish();
    await waitFor(
      'document.querySelector("textarea[aria-label=文本卡片内容]")?.value === "恢复后的完整文字"',
      'existing editor retains its shot',
    );
    console.log(
      'PASS restoring inside an existing shot freezes local return and preserves the valid active shot after restoration',
    );

    for (const leave of ['leave', 'native']) {
      await load();
      await click('恢复镜头草稿');
      await run(`void recoveryControls.${leave}()`);
      await sleep(80);
      assert.equal(await run(`recoveryControls.${leave}Result`), null);
      await run('recoveryControls.commit(); recoveryControls.reply();');
      await sleep(80);
      assert.equal(await run(`recoveryControls.${leave}Result`), null);
      await run('recoveryControls.refresh()');
      await waitFor(
        `recoveryControls.${leave}Result === true`,
        `${leave} waits for complete recovery`,
      );
      if (leave === 'leave')
        assert.equal(await run('!!document.querySelector("#home")'), true);
      console.log(
        `PASS ${leave} waits for the recovery promise even when no local edits are dirty`,
      );
    }

    await load();
    await click('恢复镜头草稿');
    await run('void recoveryControls.leave(); recoveryControls.fail();');
    await waitFor(
      'recoveryControls.leaveResult === false',
      'failed restore prevents navigation',
    );
    assert.equal(await run('!!document.querySelector("#home")'), false);
    await waitFor(
      `!${button('素材画布')}.disabled`,
      'failure unlocks controls',
    );
    await click('素材画布');
    await waitFor(
      'document.querySelector("textarea[aria-label=文本卡片内容]")?.value === "磁盘原文字"',
      'original content retained after failure',
    );
    console.log(
      'PASS failed recovery keeps the project open and original contents usable',
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    failed = true;
    console.error(error);
    console.error(errors);
    console.error(await run('document.body.innerText'));
  } finally {
    win.destroy();
    rmSync(scratch, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
    app.exit(failed ? 1 : 0);
  }
});
