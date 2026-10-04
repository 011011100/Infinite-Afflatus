// Real built main/preload/renderer against an isolated project whose SQLite file disappears.
const assert = require('node:assert/strict');
const {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog } = require('electron');

const root = resolve(__dirname, '../..');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'afflatus-recovery-')));
process.env.AFFLATUS_USER_DATA = join(scratch, 'app');
process.env.AFFLATUS_PROJECTS_DIR = join(scratch, 'projects');
delete process.env.ELECTRON_RENDERER_URL;
dialog.showErrorBox = (title, content) => {
  throw new Error(`${title}: ${content}`);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(check, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await sleep(40);
  }
  throw new Error(`Timed out: ${label}`);
}

async function main() {
  await import(pathToFileURL(join(root, 'out/main/index.js')).href);
  await waitFor(() => BrowserWindow.getAllWindows().length, 'main window');
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  const run = (script) => wc.executeJavaScript(script);
  const click = (label) =>
    run(`(() => {
      const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled);
      if (!b) throw new Error('Button unavailable: ' + ${JSON.stringify(label)});
      b.click();
    })()`);
  let capturing = false;
  const paintTimer = setInterval(async () => {
    if (capturing || win.isDestroyed()) return;
    capturing = true;
    try {
      await wc.capturePage();
    } finally {
      capturing = false;
    }
  }, 100);
  win.once('closed', () => clearInterval(paintTimer));
  await waitFor(
    () => run(`!!document.querySelector('input[aria-label="新项目名称"]')`),
    'project home',
  );
  await click('新建项目');
  await waitFor(
    () => run(`!!document.querySelector('button[aria-label="返回项目首页"]')`),
    'project canvas',
  );
  const project = await run(
    'window.desktop.getLibrary().then(s => s.projects[0])',
  );
  const database = join(scratch, 'projects', project.folder, 'project.sqlite');
  const displaced = join(scratch, 'displaced.sqlite');
  const oldBackup = join(scratch, 'old.sqlite');
  const currentBackup = join(scratch, 'current.sqlite');
  const workspace = () =>
    run(`window.desktop.getGenerationWorkspace(${JSON.stringify(project.id)})`);
  await click('新建镜头');
  await waitFor(
    () =>
      run(
        `!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === '文本卡片')`,
      ),
    'material canvas',
  );
  await click('文本卡片');
  await waitFor(
    () =>
      run(`!!document.querySelector('textarea[aria-label="文本卡片内容"]')`),
    'text material',
  );
  await run(
    `window.recoveryText = document.querySelector('textarea[aria-label="文本卡片内容"]'); window.recoveryText.focus()`,
  );
  await wc.insertText('已保存的文字');
  await waitFor(
    async () => (await workspace()).shots[0]?.nodes[0]?.text === '已保存的文字',
    'baseline saved',
  );
  const baseline = await workspace();
  copyFileSync(database, oldBackup);

  renameSync(database, displaced);
  await run(
    'window.recoveryText.focus(); window.recoveryText.setSelectionRange(window.recoveryText.value.length, window.recoveryText.value.length)',
  );
  await wc.insertText('，断开磁盘时的草稿');
  await waitFor(
    () => run(`!!document.querySelector('[data-project-unavailable]')`),
    'missing database banner',
  );
  assert.equal(
    existsSync(database),
    false,
    'a failed write must not create an empty database',
  );
  assert.equal(
    await run('window.recoveryText.isConnected'),
    true,
    'editor stays mounted',
  );
  assert.equal(
    await run('window.recoveryText.value'),
    '已保存的文字，断开磁盘时的草稿',
  );
  win.close();
  await waitFor(
    () =>
      !win.isDestroyed() &&
      run(
        `document.body.textContent.includes('仍有修改未保存') && !document.querySelector('[data-save-before-leave]')`,
      ),
    'dirty native close refused',
  );
  assert.equal(win.isDestroyed(), false);
  assert.equal(await run('window.recoveryText.isConnected'), true);
  console.log(
    'PASS real SQLite loss pauses saves, preserves the material editor and prevents dirty native close',
  );

  renameSync(displaced, database);
  await click('重试读取项目');
  await waitFor(
    () => run(`!document.querySelector('[data-project-unavailable]')`),
    'original project verified',
  );
  await waitFor(
    async () =>
      (await workspace()).shots[0]?.nodes[0]?.text ===
      '已保存的文字，断开磁盘时的草稿',
    'retained draft saved',
  );
  const recovered = await workspace();
  assert.ok(recovered.revision > baseline.revision);
  assert.equal(await run('window.recoveryText.isConnected'), true);
  await click('重试保存');
  await waitFor(
    () => run(`!document.body.textContent.includes('仍有修改未保存')`),
    'close error cleared',
  );
  console.log(
    'PASS restoring the original SQLite resumes the retained draft through real IPC without remounting',
  );

  copyFileSync(database, currentBackup);
  renameSync(database, displaced);
  await run(
    'window.recoveryText.focus(); window.recoveryText.setSelectionRange(window.recoveryText.value.length, window.recoveryText.value.length)',
  );
  await wc.insertText('，下一段草稿');
  await waitFor(
    () => run(`!!document.querySelector('[data-project-unavailable]')`),
    'second fault',
  );
  copyFileSync(oldBackup, database);
  await click('重试读取项目');
  await waitFor(
    () =>
      run(`document.body.textContent.includes('项目内容已变化，仍暂停保存')`),
    'older backup conflict',
  );
  assert.equal(
    (await workspace()).revision,
    baseline.revision,
    'recovery must not advance a stale database revision',
  );
  assert.equal((await workspace()).shots[0].nodes[0].text, '已保存的文字');
  assert.equal(
    await run('window.recoveryText.value'),
    '已保存的文字，断开磁盘时的草稿，下一段草稿',
  );
  assert.equal(await run('window.recoveryText.isConnected'), true);
  const screenshots = join(tmpdir(), 'afflatus-recovery-screens');
  mkdirSync(screenshots, { recursive: true });
  writeFileSync(
    join(screenshots, 'project-conflict.png'),
    (await wc.capturePage()).toPNG(),
  );
  console.log(
    'PASS an older same-ID project cannot overwrite a retained draft or silently unlock editing',
  );

  copyFileSync(currentBackup, database);
  await click('重试读取项目');
  await waitFor(
    () => run(`!document.querySelector('[data-project-unavailable]')`),
    'current backup verified',
  );
  await waitFor(
    async () =>
      (await workspace()).shots[0]?.nodes[0]?.text.endsWith('，下一段草稿'),
    'second retained draft saved',
  );
  console.log(
    'PASS recovery resumes only when the confirmed database version returns',
  );
  clearInterval(paintTimer);
}

main().then(
  () => {
    rmSync(scratch, { recursive: true, force: true });
    app.exit(0);
  },
  async (error) => {
    console.error(error);
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      console.error(
        await win.webContents.executeJavaScript('document.body.innerText'),
      );
    }
    rmSync(scratch, { recursive: true, force: true });
    app.exit(1);
  },
);
