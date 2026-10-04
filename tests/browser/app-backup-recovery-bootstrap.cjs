// Isolated production bootstrap. Only native dialog choices and one owned
// staging-cleanup failure are injected; backup, SQLite and recovery stay real.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { existsSync, readFileSync, realpathSync } = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const { dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog } = require('electron');

const base = process.argv
  .find((arg) => arg.startsWith('--scratch='))
  ?.slice(10);
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7);
assert.ok(
  base &&
    [
      'configure',
      'cancel',
      'restore',
      'reopen-1',
      'reopen-2',
      'repair',
    ].includes(mode),
);
assert.equal(realpathSync.native(base), base);
assert.ok(existsSync(join(base, '.fixture-owner')));
assert.equal(process.env.AFFLATUS_USER_DATA, join(base, 'profile'));
assert.equal(process.env.AFFLATUS_PROJECTS_DIR, join(base, 'projects'));
const control = JSON.parse(readFileSync(join(base, 'control.json'), 'utf8'));
const seed =
  mode === 'configure'
    ? null
    : JSON.parse(readFileSync(join(base, 'seed.json'), 'utf8'));
const errors = [];
const dialogs = [];
let pendingDialog = null;
let complete = false;
let injectedCleanups = 0;
let selectedFiles = 0;
let win;
const exit = app.exit.bind(app);
app.exit = (code = 0) => exit(complete && code === 0 ? 0 : 1);
app.on('will-quit', () => {
  if (!complete) exit(1);
});
if (mode === 'configure') {
  const unlink = fs.unlink;
  fs.unlink = async (file) => {
    if (
      typeof file === 'string' &&
      dirname(file) === join(base, 'profile', 'staging') &&
      file.endsWith('.ready')
    ) {
      injectedCleanups++;
      throw Object.assign(
        new Error(
          'Fixture keeps owned complete staging result after durable save',
        ),
        { code: 'EACCES' },
      );
    }
    return unlink(file);
  };
  syncBuiltinESMExports();
}
dialog.showOpenDialog = async (...args) => {
  if (mode === 'repair') {
    assert.equal(args.at(-1).title, '选择内容完全相同的原素材');
    assert.equal(selectedFiles++, 0);
    return {
      canceled: false,
      filePaths: [
        join(base, 'profile', 'staging', `${seed.assets[0].id}.ready`),
      ],
    };
  }
  assert.equal(mode, 'configure');
  assert.equal(selectedFiles++, 0, 'Only one fixture file picker is expected');
  return {
    canceled: false,
    filePaths: ['unique.txt', 'preserved.txt'].map((name) => join(base, name)),
  };
};
dialog.showMessageBox = (...args) =>
  new Promise((respond) => {
    assert.equal(pendingDialog, null, 'Native dialogs must be sequential');
    const options = args.at(-1);
    dialogs.push({
      title: options.title,
      message: options.message,
      detail: options.detail,
      buttons: options.buttons,
    });
    pendingDialog = { options, respond };
  });
dialog.showErrorBox = (title, message) => errors.push(`${title}: ${message}`);
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false);
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
});
const sleep = (ms) =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    assert.deepEqual(errors, [], label);
    const value = await check();
    if (value) return value;
    await sleep(40);
  }
  throw new Error(`Timed out: ${label}`);
}
async function respond(title, label) {
  await waitFor(
    () => pendingDialog?.options.title === title,
    `native ${title}`,
  );
  const current = pendingDialog;
  const response = current.options.buttons.indexOf(label);
  assert.ok(response >= 0, `Native action ${label} exists`);
  pendingDialog = null;
  current.respond({ response, checkboxChecked: false });
}
async function run(code) {
  return win.webContents.executeJavaScript(code);
}
const query = (label) =>
  `[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent.trim()) === ${JSON.stringify(label)} && !b.closest('[inert]') && b.getClientRects().length)`;
async function click(label) {
  await waitFor(
    () => run(`!!${query(label)} && !${query(label)}.disabled`),
    `enabled ${label}`,
  );
  await run(`(${query(label)}).click()`);
}
async function storage() {
  await click('设置');
  await click('保存与存储');
  await waitFor(
    () =>
      run(
        `!!document.querySelector('section[aria-label="应用索引与设置备份"]') && !document.querySelector('section[aria-label="应用索引与设置备份"]').getAttribute('aria-busy').includes('true')`,
      ),
    'backup list loaded',
  );
}
async function configure() {
  await click('新建项目');
  await waitFor(
    () => run('!!document.querySelector("button[aria-label=返回项目首页]")'),
    'new project canvas',
  );
  const project = (await run('window.desktop.getLibrary()')).projects[0];
  const id = JSON.stringify(project.id);
  const result = await run(
    `window.desktop.importReferences(${id}, ${JSON.stringify(randomUUID())})`,
  );
  assert.equal(result.assetIds.length, 2);
  assert.deepEqual(result.errors, []);
  await waitFor(async () => {
    const library = await run('window.desktop.getLibrary()');
    return (
      library.jobs.length === 2 &&
      library.jobs.every((job) => job.status === 'saved') &&
      injectedCleanups === 2
    );
  }, 'two real saved results with deliberately retained staging copies');
  const snapshot = await run(`window.desktop.openProject(${id})`);
  const assets = result.assetIds.map((assetId) =>
    snapshot.assets.find((asset) => asset.id === assetId),
  );
  assert.ok(assets.every(Boolean));
  const baseline = await run(`window.desktop.getGenerationWorkspace(${id})`);
  const workspace = structuredClone(baseline);
  workspace.shots.push({
    id: randomUUID(),
    name: '备份保留草稿',
    position: { x: 0, y: 0 },
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: randomUUID(),
        type: 'text',
        text: '仅存在独立保护文件中的文字',
        position: { x: 0, y: 0 },
      },
    ],
    groups: [],
  });
  await run(
    `window.desktop.protectWorkspaceDraft(${id}, ${JSON.stringify({ sessionId: randomUUID(), seq: 1, baseline, workspace })})`,
  );
  await run(
    `window.desktop.protectProjectEditDraft(${id}, ${JSON.stringify({ kind: 'name', sessionId: randomUUID(), seq: 1, baseline: project.name, target: '尚未确认的新项目名称' })})`,
  );
  const interactions = (await run('window.desktop.getLibrary()')).interactions;
  interactions.longPressSplit = false;
  await run(`window.desktop.saveInteractions(${JSON.stringify(interactions)})`);
  await storage();
  await click('创建本机备份');
  await waitFor(
    () =>
      run(
        'document.querySelector("section[aria-label=应用索引与设置备份]").innerText.includes("已创建本机备份：")',
      ),
    'UI backup success',
  );
  const list = await run('window.desktop.getAppBackups()');
  assert.equal(list.backups.length, 1);
  assert.equal(list.backups[0].restorable, true);
  assert.equal(list.backups[0].root, join(base, 'projects'));
  await run(
    'document.querySelector("section[aria-label=应用索引与设置备份]").scrollIntoView({block:"center"})',
  );
  await sleep(100);
  await fs.writeFile(
    control.screenshot,
    (await win.webContents.capturePage()).toPNG(),
    { flag: 'wx' },
  );
  await fs.writeFile(
    join(base, 'seed.json'),
    JSON.stringify({ project, assets, backup: list.backups[0] }),
    { flag: 'wx' },
  );
  // Recovery must restore the backed-up setting, not the last value before corruption.
  interactions.longPressSplit = true;
  await run(`window.desktop.saveInteractions(${JSON.stringify(interactions)})`);
  await click('关闭');
  await click('返回项目首页');
  console.log(
    'PASS configure: settings button creates a real local backup; two real saved references retain ready copies; independent name/workspace drafts and backup success screenshot recorded',
  );
}
async function verifyRestored() {
  const state = await run('window.desktop.getLibrary()');
  assert.equal(state.root, join(base, 'projects'));
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].id, seed.project.id);
  assert.equal(state.interactions.longPressSplit, false);
  assert.deepEqual(
    state.jobs,
    [],
    'Old tasks must not enter the live save/cleanup queue',
  );
  const id = JSON.stringify(seed.project.id);
  const snapshot = await run(`window.desktop.openProject(${id})`);
  assert.equal(snapshot.project.name, seed.project.name);
  assert.deepEqual(snapshot.assets, seed.assets);
  assert.equal(
    (await run(`window.desktop.listWorkspaceDrafts(${id})`)).drafts.length,
    1,
  );
  assert.equal(
    (await run(`window.desktop.listProjectEditDrafts(${id})`)).drafts.length,
    1,
  );
  await storage();
  const list = await run('window.desktop.getAppBackups()');
  assert.equal(list.recovery.backupId, seed.backup.id);
  assert.equal(list.recovery.retainedJobCount, 2);
  assert.ok(list.recovery.retainedFileCount >= 2);
  assert.equal(list.backups.length, 1);
  await waitFor(
    () =>
      run(
        'document.querySelector("section[aria-label=应用索引与设置备份]").innerText.includes("原资料保留位置：")',
      ),
    'retained recovery details shown',
  );
  await fs.writeFile(
    join(base, `${mode}.json`),
    JSON.stringify(list.recovery),
    { flag: 'wx' },
  );
  await click('关闭');
}

async function repair() {
  await run(
    `(() => {const label=[...document.querySelectorAll('button span')].find(s=>s.textContent.trim()===${JSON.stringify(seed.project.name)});if(!label)throw new Error('Restored project not visible');label.closest('button').click()})()`,
  );
  await waitFor(
    () => run('!!document.querySelector("button[aria-label=返回项目首页]")'),
    'restored project opens',
  );
  await click('1 个素材需要检查');
  await click('找到原文件');
  await waitFor(
    () =>
      run(
        'document.querySelector("dialog[open]").innerText.includes("未发现缺失或大小异常的素材")',
      ),
    'original media restored from retained ready result',
  );
  assert.equal(selectedFiles, 1);
  const report = await run(
    `window.desktop.scanProjectHealth(${JSON.stringify(seed.project.id)}, 'full')`,
  );
  assert.deepEqual(report.issues, []);
  await click('关闭');
  await click('返回项目首页');
  console.log(
    'PASS repair: real health UI selects the retained .ready, validates original hash and restores only the missing registered media; full content check passes',
  );
}

(async () => {
  // Main initialization waits on native recovery; do not await its import before
  // answering the real startup dialogs.
  const starting = import(
    pathToFileURL(join(resolve(__dirname, '../..'), 'out/main/index.js')).href
  );
  if (mode === 'cancel' || mode === 'restore') {
    await respond('无法打开项目库', '检查本机备份');
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    await respond('检查本机备份', '检查最近备份');
    await respond(
      '确认恢复应用索引与设置',
      mode === 'cancel' ? '取消' : '恢复并打开项目库',
    );
    if (mode === 'cancel') {
      await waitFor(
        () => pendingDialog?.options.title === '无法打开项目库',
        'cancel returns to startup failure',
      );
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      complete = true;
      await respond('无法打开项目库', '退出');
      await starting;
      return;
    }
    await respond('应用索引与设置已恢复', '继续');
  }
  await starting;
  win = await waitFor(
    () => BrowserWindow.getAllWindows()[0],
    'real main window',
  );
  await waitFor(
    () => run('!!document.querySelector("input[aria-label=新项目名称]")'),
    'real project home',
  );
  assert.equal(new URL(win.webContents.getURL()).protocol, 'file:');
  if (mode === 'configure') await configure();
  else {
    await verifyRestored();
    if (mode === 'repair') await repair();
  }
  assert.deepEqual(errors, []);
  assert.equal(pendingDialog, null);
  complete = true;
  app.quit();
})().catch(async (error) => {
  console.error(error);
  console.error(JSON.stringify({ mode, dialogs, errors, injectedCleanups }));
  if (win && !win.isDestroyed())
    console.error(
      await run('document.body.innerText').catch(() => 'renderer unavailable'),
    );
  exit(1);
});
