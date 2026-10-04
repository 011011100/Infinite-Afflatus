// Real Settings + recovery-list hooks, with delayed typed native import responses.
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
  mkdtempSync(join(root, 'src/renderer/.rescue-import-controls-'));
const profile =
  process.env.AFFLATUS_FIXTURE_PROFILE ??
  mkdtempSync(join(tmpdir(), 'afflatus-rescue-controls-'));
app.setPath('userData', profile);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>恢复文件导入回归</title></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/rescue-import-controls.fixture.tsx"></script></body></html>`,
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
  const state = () => run('rescueControls.state()');
  const text = () =>
    run('document.querySelector("section[aria-label=导入恢复文件]").innerText');
  const preview = 'document.querySelector("section[aria-label=恢复文件预览]")';
  const wait = async (condition, label) => {
    for (let n = 0; n < 250; n++) {
      if (await run(condition)) return;
      await sleep(20);
    }
    throw new Error(`Timeout: ${label}`);
  };
  const ready = () =>
    wait(
      `!!${button('导入恢复文件')} && !${button('导入恢复文件')}.disabled`,
      'import idle',
    );
  const choose = async (options = {}) => {
    await click('导入恢复文件');
    await run(`rescueControls.choose(undefined,${JSON.stringify(options)})`);
    await ready();
    await wait(`!!${preview}`, 'preview');
  };
  const untouched = async () => {
    const value = await state();
    assert.equal(value.flushes, 0);
    assert.equal(value.restores, 0);
    assert.equal(value.protections, 0);
    assert.equal(
      await run('document.querySelector("textarea").value'),
      '尚未保存的文字',
    );
  };
  let failed = false;
  try {
    await win.loadURL(`${origin}/${basename(scratch)}/index.html`);
    await wait(
      '!!document.querySelector("dialog[open]") && typeof rescueControls!=="undefined"',
      'settings',
    );
    await run(
      'new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    assert.equal((await state()).choices, 0);
    await click('保存与存储');
    await ready();
    assert.equal((await state()).choices, 0);
    const initialLists = (await state()).lists.length;
    await click('导入恢复文件');
    await run('rescueControls.choose(undefined,null)');
    await ready();
    assert.equal(await run(`!!${preview}`), false);
    assert.equal((await state()).confirmations, 0);
    assert.equal((await state()).lists.length, initialLists);
    await untouched();
    console.log(
      'PASS opening settings is read-only; cancelling the native chooser changes no drafts or current input',
    );

    await choose();
    assert.match(await text(), /整个镜头工作区 · 3 个镜头 · 2 个素材引用/);
    assert.match(await text(), /不是只添加到当前镜头/);
    assert.match(await text(), /草稿保存时间/);
    assert.match(await text(), /原项目：项目A/);
    assert.equal((await state()).confirmations, 0);
    await run(
      'Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{})))',
    );
    await run(
      'document.querySelector("section[aria-label=导入恢复文件]").scrollIntoView({block:"end"}); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    await wait(
      'document.querySelector("section[aria-label=恢复文件预览]").getBoundingClientRect().bottom < innerHeight',
      'preview scrolled into view',
    );
    await sleep(100);
    const screenshot =
      process.env.AFFLATUS_RESCUE_IMPORT_SCREENSHOT ??
      join(tmpdir(), 'afflatus-rescue-import-controls.png');
    writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
    console.log(`SCREENSHOT simulated native IPC: ${screenshot}`);
    await click('取消预览');
    await ready();
    assert.equal(await run(`!!${preview}`), false);
    assert.equal((await state()).confirmations, 0);
    assert.equal((await state()).lists.length, initialLists);
    await untouched();
    console.log(
      'PASS preview discloses whole-workspace scope; explicit dismissal publishes nothing',
    );

    await choose();
    await run(`{ const b=${button('导入为恢复副本')}; b.click(); b.click(); }`);
    assert.equal((await state()).confirmations, 1);
    assert.equal(await run(`${button('正在导入恢复副本…')}.disabled`), true);
    assert.equal(await run(`${button('取消预览')}.disabled`), true);
    await run('rescueControls.confirm()');
    await ready();
    await wait(
      'document.querySelector("[data-draft-counts]").textContent==="1:0"',
      'workspace list updated',
    );
    assert.equal((await state()).lists.length, initialLists + 2);
    assert.match(await text(), /恢复副本已导入，原项目未改动/);
    assert.match(await text(), /关闭设置后，可在当前项目的恢复提示中处理/);
    await untouched();
    console.log(
      'PASS one explicit confirmation refreshes both current-project lists without saving, applying or replacing live input',
    );

    const beforeOther = (await state()).lists.length;
    await choose({ project: { id: 'B', folder: 'folder-B', name: '项目B' } });
    await click('导入为恢复副本');
    await run('rescueControls.confirm()');
    await ready();
    assert.equal((await state()).lists.length, beforeOther);
    assert.match(await text(), /稍后打开「项目B」查看恢复提示/);
    assert.equal(
      await run('document.querySelector("[data-draft-counts]").textContent'),
      '1:0',
    );
    await untouched();
    console.log(
      'PASS another project remains unopened and cannot refresh or replace the current editor',
    );

    await choose({
      kind: 'name',
      state: 'conflict',
      nameBaseline: '原名称',
      nameTarget: '   ',
    });
    assert.match(await text(), /原名称：原名称/);
    assert.match(await text(), /（空名称输入）/);
    assert.match(await text(), /暂不能恢复；不会覆盖当前内容/);
    await click('导入为恢复副本');
    await run('rescueControls.confirm(undefined,true)');
    await ready();
    await wait(
      'document.querySelector("[data-draft-counts]").textContent==="1:1"',
      'edit list updated',
    );
    assert.match(await text(), /此恢复副本已存在，未重复导入/);
    await untouched();
    console.log(
      'PASS conflict and raw blank-name records are importable copies only; duplicate publication has an explicit result',
    );

    for (const message of [
      '未找到对应的原项目，不能按同名关联',
      '缺少此草稿引用的 2 个素材，请先恢复原项目素材',
    ]) {
      await click('导入恢复文件');
      await run(`rescueControls.failChoose(${JSON.stringify(message)})`);
      await ready();
      assert.match(await text(), new RegExp(message));
      assert.equal(await run(`!!${preview}`), false);
      assert.match(await text(), /此恢复副本已存在/);
    }
    await untouched();
    console.log(
      'PASS unknown-project and missing-media errors expose no confirmation and retain the previous completed result',
    );

    await click('导入恢复文件');
    const oldChoice = (await state()).choices - 1;
    const beforeCancel = (await state()).cancels;
    await click('交互与快捷键');
    await wait(
      `rescueControls.state().cancels===${beforeCancel + 1}`,
      'tab switch cancels inspection',
    );
    await run(
      `rescueControls.choose(${oldChoice},{sourceName:'迟到旧预览.json'})`,
    );
    await click('保存与存储');
    await ready();
    assert.equal(await run(`!!${preview}`), false);
    await choose({
      kind: 'trim',
      sourceName: '新裁剪预览.json',
      cardId: 'card-A',
    });
    assert.match(await text(), /一张视频卡片的裁剪/);
    assert.doesNotMatch(await text(), /迟到旧预览/);
    await click('取消预览');
    await ready();
    console.log(
      'PASS leaving the storage tab invalidates old picker replies and permits a new independent preview',
    );

    await choose({
      kind: 'name',
      nameBaseline: '旧名字',
      nameTarget: '关闭后导入',
    });
    await click('导入为恢复副本');
    const importing = (await state()).confirmations - 1;
    const beforeUnmountLists = (await state()).lists.length;
    const beforeUnmountCancels = (await state()).cancels;
    await run('rescueControls.show(false)');
    await wait(
      '!document.querySelector("dialog")',
      'unmounted confirmed import',
    );
    await run('rescueControls.show(true)');
    await wait('!!document.querySelector("dialog[open]")', 'new settings');
    await click('保存与存储');
    await choose({ sourceName: '新设置中的预览.json' });
    await run(`rescueControls.confirm(${importing})`);
    await wait(
      `rescueControls.state().lists.length===${beforeUnmountLists + 2}`,
      'late durable import refreshes active lists',
    );
    assert.equal((await state()).cancels, beforeUnmountCancels);
    assert.match(await text(), /新设置中的预览/);
    assert.doesNotMatch(await text(), /关闭后导入|恢复副本已导入/);
    await untouched();
    await click('取消预览');
    await ready();
    console.log(
      'PASS confirmed publication survives panel unmount and still notifies lists without changing a newer preview',
    );

    await choose({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    const beforeExpired = (await state()).confirmations;
    assert.equal(await run(`${button('导入为恢复副本')}.disabled`), true);
    await click('导入为恢复副本');
    assert.equal((await state()).confirmations, beforeExpired);
    assert.match(await text(), /此预览已失效/);
    await click('取消预览');
    await ready();
    await choose();
    await click('导入为恢复副本');
    await run('rescueControls.failConfirm()');
    await ready();
    assert.match(await text(), /文件已经变化，请重新选择检查/);
    assert.equal(await run(`${button('导入为恢复副本')}.disabled`), true);
    await click('取消预览');
    await ready();
    await run('rescueControls.block(true)');
    await wait(`${button('导入恢复文件')}.disabled`, 'migration lock');
    const beforeBlocked = (await state()).choices;
    await click('导入恢复文件');
    assert.equal((await state()).choices, beforeBlocked);
    await untouched();
    console.log(
      'PASS expiry, changed preview and migration locks never reuse a consumed confirmation',
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
    } finally {
      app.exit(failed ? 1 : 0);
    }
  }
});
