// Production startup, preload and renderer. Only native choices and the owned
// fixture's final staging unlink are injected; directory/SQLite checks stay real.
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
      'wrong-copy',
      'quit-picker',
      'confirm',
      'reopen-1',
      'reopen-2',
    ].includes(mode),
);
assert.equal(realpathSync.native(base), base);
assert.ok(existsSync(join(base, '.fixture-owner')));
assert.equal(process.env.AFFLATUS_USER_DATA, join(base, 'profile'));
assert.equal(process.env.AFFLATUS_PROJECTS_DIR, join(base, 'projects'));
const moved = join(base, 'moved 项目 中文');
const seed =
  mode === 'configure'
    ? null
    : JSON.parse(readFileSync(join(base, 'seed.json'), 'utf8'));
const errors = [];
const dialogs = [];
let pendingDialog = null;
let pendingPicker = null;
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
        new Error('Fixture retains a complete saved result'),
        { code: 'EACCES' },
      );
    }
    return unlink(file);
  };
  syncBuiltinESMExports();
}
dialog.showOpenDialog = async (...args) => {
  const options = args.at(-1);
  if (mode === 'configure') {
    assert.equal(selectedFiles++, 0);
    return {
      canceled: false,
      filePaths: ['unique.txt', 'preserved.txt'].map((name) =>
        join(base, name),
      ),
    };
  }
  assert.equal(options.title, '选择移动或改名后的原项目目录');
  assert.equal(options.buttonLabel, '检查原项目目录');
  assert.deepEqual(options.properties, ['openDirectory']);
  selectedFiles++;
  if (mode === 'quit-picker')
    return new Promise((respond) => {
      pendingPicker = respond;
    });
  if (mode === 'cancel' && selectedFiles === 1)
    return { canceled: true, filePaths: [] };
  return {
    canceled: false,
    filePaths: [mode === 'wrong-copy' ? join(base, 'copied-projects') : moved],
  };
};
dialog.showMessageBox = (...args) =>
  new Promise((respond) => {
    assert.equal(pendingDialog, null, 'Native dialogs must be sequential');
    const options = args.at(-1);
    dialogs.push({
      title: options.title,
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
async function configure() {
  const primary = await run('window.desktop.createProject("重新定位原项目")');
  const independent = await run(
    'window.desktop.createProject("独立项目保持不变")',
  );
  const id = JSON.stringify(primary.project.id);
  const result = await run(
    `window.desktop.importReferences(${id}, ${JSON.stringify(randomUUID())})`,
  );
  assert.equal(result.assetIds.length, 2);
  assert.deepEqual(result.errors, []);
  await waitFor(async () => {
    const state = await run('window.desktop.getLibrary()');
    return (
      state.jobs.length === 2 &&
      state.jobs.every((job) => job.status === 'saved') &&
      injectedCleanups === 2
    );
  }, 'two real saved results with retained copies');
  const snapshot = await run(`window.desktop.openProject(${id})`);
  const assets = result.assetIds.map((assetId) =>
    snapshot.assets.find((asset) => asset.id === assetId),
  );
  assert.ok(assets.every(Boolean));
  const baseline = await run(`window.desktop.getGenerationWorkspace(${id})`);
  const workspace = structuredClone(baseline);
  workspace.shots.push({
    id: randomUUID(),
    name: '重新定位后保留草稿',
    position: { x: 0, y: 0 },
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      {
        id: randomUUID(),
        type: 'text',
        text: '独立保护文件中的文字',
        position: { x: 0, y: 0 },
      },
    ],
    groups: [],
  });
  await run(
    `window.desktop.protectWorkspaceDraft(${id}, ${JSON.stringify({ sessionId: randomUUID(), seq: 1, baseline, workspace })})`,
  );
  await run(
    `window.desktop.protectProjectEditDraft(${id}, ${JSON.stringify({ kind: 'name', sessionId: randomUUID(), seq: 1, baseline: primary.project.name, target: '尚未确认的新项目名称' })})`,
  );
  const interactions = (await run('window.desktop.getLibrary()')).interactions;
  interactions.longPressSplit = false;
  await run(`window.desktop.saveInteractions(${JSON.stringify(interactions)})`);
  await fs.writeFile(
    join(base, 'seed.json'),
    JSON.stringify({
      project: primary.project,
      independent: independent.project,
      assets,
      state: await run('window.desktop.getLibrary()'),
    }),
    { flag: 'wx' },
  );
  console.log(
    'PASS configure: two real projects, settings, two saved tasks, retained ready copies and both independent draft formats',
  );
}
async function verify() {
  const state = await run('window.desktop.getLibrary()');
  assert.equal(state.root, moved);
  assert.deepEqual(state.projects, seed.state.projects);
  assert.deepEqual(
    state.jobs,
    seed.state.jobs,
    'Relocation must preserve the live queue, including saved receipts',
  );
  assert.equal(state.interactions.longPressSplit, false);
  const id = JSON.stringify(seed.project.id);
  const snapshot = await run(`window.desktop.openProject(${id})`);
  assert.deepEqual(snapshot.assets, seed.assets);
  assert.equal(
    (await run(`window.desktop.listWorkspaceDrafts(${id})`)).drafts.length,
    1,
  );
  assert.equal(
    (await run(`window.desktop.listProjectEditDrafts(${id})`)).drafts.length,
    1,
  );
  const other = await run(
    `window.desktop.openProject(${JSON.stringify(seed.independent.id)})`,
  );
  assert.equal(other.project.id, seed.independent.id);
  assert.deepEqual(other.assets, []);
  await fs.writeFile(
    join(base, `${mode}.json`),
    JSON.stringify({ root: state.root, jobs: state.jobs }),
    { flag: 'wx' },
  );
  console.log(
    `PASS ${mode}: production main opens original projects at relocated root; tasks, settings and both draft formats remain available`,
  );
}

(async () => {
  const starting = import(
    pathToFileURL(join(resolve(__dirname, '../..'), 'out/main/index.js')).href
  );
  if (['cancel', 'wrong-copy', 'quit-picker', 'confirm'].includes(mode)) {
    await respond('无法打开项目库', '重新定位原项目目录');
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    if (mode === 'quit-picker') {
      await waitFor(() => pendingPicker, 'native picker pending');
      complete = true;
      app.quit();
      // A late native result must not start a preview/publication or open a window.
      pendingPicker({ canceled: false, filePaths: [moved] });
      await starting;
      return;
    }
    if (mode === 'cancel')
      await respond('无法打开项目库', '重新定位原项目目录');
    if (mode === 'wrong-copy') {
      await waitFor(
        () => pendingDialog?.options.title === '无法打开项目库',
        'copied directory rejected',
      );
      assert.equal(
        dialogs.some((entry) => entry.title === '确认重新定位原项目目录'),
        false,
      );
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      complete = true;
      await respond('无法打开项目库', '退出');
      await starting;
      return;
    }
    await waitFor(
      () => pendingDialog?.options.title === '确认重新定位原项目目录',
      'verified preview',
    );
    assert.equal(pendingDialog.options.defaultId, 1);
    assert.equal(pendingDialog.options.cancelId, 1);
    for (const value of [
      join(base, 'projects'),
      moved,
      seed.project.name,
      seed.independent.name,
    ])
      assert.ok(pendingDialog.options.detail.includes(value));
    await respond(
      '确认重新定位原项目目录',
      mode === 'cancel' ? '取消' : '确认位置并重新打开',
    );
    if (mode === 'cancel') {
      await waitFor(
        () => pendingDialog?.options.title === '无法打开项目库',
        'cancelled confirmation returns to failure',
      );
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      assert.equal(selectedFiles, 2);
      complete = true;
      await respond('无法打开项目库', '退出');
      await starting;
      return;
    }
  }
  await starting;
  win = await waitFor(
    () => BrowserWindow.getAllWindows()[0],
    'production window',
  );
  await waitFor(
    () => run('!!document.querySelector("input[aria-label=新项目名称]")'),
    'project home',
  );
  assert.equal(new URL(win.webContents.getURL()).protocol, 'file:');
  if (mode === 'configure') await configure();
  else await verify();
  assert.deepEqual(errors, []);
  assert.equal(pendingDialog, null);
  complete = true;
  app.quit();
})().catch(async (error) => {
  console.error(error);
  console.error(JSON.stringify({ mode, dialogs, errors, injectedCleanups }));
  exit(1);
});
