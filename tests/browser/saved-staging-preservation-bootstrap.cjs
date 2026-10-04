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
    ['configure', 'reopen-1', 'reopen-2', 'repair', 'reopen-repaired'].includes(
      mode,
    ),
);
assert.equal(realpathSync.native(base), base);
assert.ok(existsSync(join(base, '.fixture-owner')));
assert.equal(process.env.AFFLATUS_USER_DATA, join(base, 'profile'));
assert.equal(process.env.AFFLATUS_PROJECTS_DIR, join(base, 'projects'));
const seed =
  mode === 'configure'
    ? null
    : JSON.parse(readFileSync(join(base, 'seed.json'), 'utf8'));
const errors = [];
let picked = 0;
let confirmations = 0;
let injected = 0;
let retaining = mode === 'configure';
let complete = false;
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
      retaining &&
      typeof file === 'string' &&
      dirname(file) === join(base, 'profile', 'staging') &&
      file.endsWith('.ready')
    ) {
      injected++;
      throw Object.assign(
        new Error('Fixture locks only final saved staging cleanup'),
        { code: 'EACCES' },
      );
    }
    return unlink(file);
  };
  syncBuiltinESMExports();
}
dialog.showOpenDialog = async (...args) => {
  picked++;
  if (mode === 'configure') {
    assert.ok(picked <= 2);
    return {
      canceled: false,
      filePaths: (picked === 1
        ? ['missing.txt', 'changed.txt', 'valid.txt']
        : ['independent.txt']
      ).map((name) => join(base, name)),
    };
  }
  assert.equal(mode, 'repair');
  assert.equal(picked, 1);
  assert.equal(args.at(-1).title, '选择内容完全相同的原素材');
  return { canceled: true, filePaths: [] };
};
dialog.showErrorBox = (title, message) => errors.push(`${title}: ${message}`);
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  assert.equal(mode, 'repair');
  assert.equal(options.title, '发现保留的素材副本');
  assert.deepEqual(options.buttons, ['验证并恢复', '选择其他原文件', '取消']);
  assert.equal(options.defaultId, 2);
  assert.equal(options.cancelId, 2);
  assert.ok(options.detail.includes(seed.assets[0].name));
  assert.ok(
    options.detail.includes(
      join(base, 'profile', 'staging', `${seed.assets[0].id}.ready`),
    ),
  );
  assert.ok(
    confirmations < 3,
    'Only three explicit candidate confirmations expected',
  );
  return { response: [2, 1, 0][confirmations++], checkboxChecked: false };
};
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false);
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
});
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    assert.deepEqual(errors, [], label);
    const result = await check();
    if (result) return result;
    await sleep(40);
  }
  throw new Error(`Timed out: ${label}`);
}
const run = (code) => win.webContents.executeJavaScript(code);
const api = (method, ...args) =>
  run(
    `window.desktop.${method}(${args.map((value) => JSON.stringify(value)).join(',')})`,
  );
const button = (label) =>
  `[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent.trim()) === ${JSON.stringify(label)} && !b.closest('[inert]') && b.getClientRects().length)`;
async function click(label) {
  await waitFor(
    () => run(`!!${button(label)} && !${button(label)}.disabled`),
    `enabled ${label}`,
  );
  await run(`(${button(label)}).click()`);
}
async function configure() {
  const { project } = await api('createProject', '普通重启保护最后暂存');
  const refs = await api('importReferences', project.id, randomUUID());
  assert.equal(refs.assetIds.length, 3);
  assert.deepEqual(refs.errors, []);
  await waitFor(
    async () =>
      (await api('getLibrary')).jobs.length === 3 &&
      (await api('getLibrary')).jobs.every((job) => job.status === 'saved') &&
      injected === 3,
    'three durable saved results with failed final cleanup',
  );
  retaining = false;
  const snapshot = await api('openProject', project.id);
  const assets = refs.assetIds.map((id) =>
    snapshot.assets.find((asset) => asset.id === id),
  );
  assert.ok(assets.every(Boolean));
  const other = await api('createProject', '独立项目原样保留');
  const otherRefs = await api(
    'importReferences',
    other.project.id,
    randomUUID(),
  );
  assert.equal(otherRefs.assetIds.length, 1);
  assert.deepEqual(otherRefs.errors, []);
  await waitFor(
    async () =>
      (await api('getLibrary')).jobs.every((job) => job.status === 'saved'),
    'independent reference saved',
  );
  await fs.writeFile(
    join(base, 'seed.json'),
    JSON.stringify({
      project,
      snapshot,
      assets,
      independent: await api('openProject', other.project.id),
      jobs: (await api('getLibrary')).jobs,
    }),
    { flag: 'wx' },
  );
  assert.equal(injected, 3);
  console.log(
    'PASS configure: production import and save create three saved+ready pairs via only final unlink EACCES; independent project saved normally',
  );
}
async function verify() {
  assert.deepEqual(
    (await api('getLibrary')).jobs,
    seed.jobs,
    'Historical saved tasks retain every field',
  );
  assert.deepEqual(await api('openProject', seed.project.id), seed.snapshot);
  assert.deepEqual(
    await api('openProject', seed.independent.project.id),
    seed.independent,
  );
  const report = await api('scanProjectHealth', seed.project.id, 'full');
  assert.equal(report.issues.length, mode === 'reopen-repaired' ? 1 : 2);
  assert.ok(report.issues.some((issue) => issue.assetId === seed.assets[1].id));
  if (mode !== 'reopen-repaired')
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.assetId === seed.assets[0].id && issue.problem === 'missing',
      ),
    );
  if (mode === 'repair') {
    await run(
      `([...document.querySelectorAll('button span')].find(s=>s.textContent.trim()===${JSON.stringify(seed.project.name)})).closest('button').click()`,
    );
    await waitFor(
      () => run('!!document.querySelector("button[aria-label=返回项目首页]")'),
      'project canvas',
    );
    await click('1 个素材需要检查');
    for (let attempt = 0; attempt < 2; attempt++) {
      await click('找到原文件');
      await waitFor(
        () =>
          confirmations === attempt + 1 &&
          run(`!!${button('找到原文件')} && !${button('找到原文件')}.disabled`),
        'cancelled source choice releases existing restore control',
      );
      assert.equal(
        existsSync(
          join(
            base,
            'projects',
            seed.project.folder,
            seed.assets[0].relativePath,
          ),
        ),
        false,
        'Cancelling candidate or picker cannot restore',
      );
      assert.deepEqual(
        await fs.readFile(
          join(base, 'profile', 'staging', `${seed.assets[0].id}.ready`),
        ),
        await fs.readFile(join(base, 'missing.txt')),
      );
      assert.deepEqual((await api('getLibrary')).jobs, seed.jobs);
    }
    await click('找到原文件');
    await waitFor(
      () =>
        run(
          'document.querySelector("dialog[open]").innerText.includes("未发现缺失或大小异常的素材")',
        ),
      'missing file restored through existing health UI',
    );
    assert.equal(picked, 1);
    assert.equal(confirmations, 3);
    const after = await api('scanProjectHealth', seed.project.id, 'full');
    assert.equal(after.issues.length, 1);
    assert.equal(after.issues[0].assetId, seed.assets[1].id);
    assert.deepEqual((await api('getLibrary')).jobs, seed.jobs);
    await click('关闭');
    await click('返回项目首页');
  }
  console.log(
    `PASS ${mode}: ordinary startup retains saved records; complete health scan identifies changed content; ${mode === 'repair' ? 'explicit native selection restores only the missing file' : 'no automatic media replay'}`,
  );
}
(async () => {
  await import(
    pathToFileURL(join(resolve(__dirname, '../..'), 'out/main/index.js')).href
  );
  win = await waitFor(
    () => BrowserWindow.getAllWindows()[0],
    'production window',
  );
  await waitFor(
    () =>
      run(
        'document.readyState === "complete" && !!document.querySelector("input[aria-label=新项目名称]")',
      ),
    'real loaded home',
  );
  assert.equal(new URL(win.webContents.getURL()).protocol, 'file:');
  if (mode === 'configure') await configure();
  else await verify();
  assert.deepEqual(errors, []);
  complete = true;
  app.quit();
})().catch(async (error) => {
  console.error(error);
  console.error(JSON.stringify({ mode, errors, picked, injected }));
  if (win && !win.isDestroyed())
    console.error(
      await run('document.body.innerText').catch(() => 'renderer unavailable'),
    );
  exit(1);
});
