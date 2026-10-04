// Dialog selection is the only substitution. All export/import/recovery code,
// filesystem operations and project transactions run in the production bundle.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { existsSync, readFileSync, realpathSync } = require('node:fs');
const fs = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog } = require('electron');
const base = process.argv
  .find((arg) => arg.startsWith('--scratch='))
  ?.slice(10);
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7);
assert.ok(
  base &&
    ['configure', 'import', 'restore', 'reopen-1', 'reopen-2'].includes(mode),
);
assert.equal(realpathSync.native(base), base);
assert.ok(existsSync(join(base, '.fixture-owner')));
assert.equal(process.env.AFFLATUS_USER_DATA, join(base, 'profile'));
assert.equal(process.env.AFFLATUS_PROJECTS_DIR, join(base, 'projects'));
const exportPath = join(base, 'external', '中文 空格 救援.afflatus-draft.json');
const seed =
  mode === 'configure'
    ? null
    : JSON.parse(readFileSync(join(base, 'seed.json'), 'utf8'));
const errors = [];
let picked = 0;
let exported = 0;
let complete = false;
let win;
const exit = app.exit.bind(app);
app.exit = (code = 0) => exit(complete && code === 0 ? 0 : 1);
app.on('will-quit', () => {
  if (!complete) exit(1);
});
dialog.showOpenDialog = async (...args) => {
  picked++;
  if (mode === 'configure') {
    assert.equal(picked, 1);
    return {
      canceled: false,
      filePaths: [join(base, '第一份.txt'), join(base, 'second.txt')],
    };
  }
  assert.equal(mode, 'import');
  assert.equal(args.at(-1).title, '导入恢复文件');
  return { canceled: false, filePaths: [exportPath] };
};
dialog.showSaveDialog = async (...args) => {
  assert.equal(mode, 'configure');
  assert.equal(exported++, 0);
  assert.equal(args.at(-1).title, '导出只读镜头恢复文件');
  return { canceled: false, filePath: exportPath };
};
dialog.showErrorBox = (title, message) => errors.push(`${title}: ${message}`);
dialog.showMessageBox = async (...args) => {
  errors.push(`Unexpected native message: ${JSON.stringify(args.at(-1))}`);
  return { response: 0, checkboxChecked: false };
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
const button = (label) =>
  `[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent.trim()) === ${JSON.stringify(label)} && !b.closest('[inert]') && b.getClientRects().length)`;
async function click(label) {
  await waitFor(
    () => run(`!!${button(label)} && !${button(label)}.disabled`),
    `enabled ${label}`,
  );
  await run(`(${button(label)}).click()`);
}
const api = (method, ...args) =>
  run(
    `window.desktop.${method}(${args.map((value) => JSON.stringify(value)).join(',')})`,
  );
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function withoutTimestamp(snapshot) {
  const result = structuredClone(snapshot);
  delete result.project.updatedAt;
  return result;
}
async function configure() {
  const snapshot = await api('createProject', '真实救援导入项目');
  const project = snapshot.project;
  const refs = await api('importReferences', project.id, randomUUID());
  assert.equal(refs.assetIds.length, 2);
  assert.deepEqual(refs.errors, []);
  await waitFor(
    async () =>
      (await api('getLibrary')).jobs.every((job) => job.status === 'saved'),
    'real references saved',
  );
  const saved = await api('openProject', project.id);
  const assets = refs.assetIds.map((id) =>
    saved.assets.find((asset) => asset.id === id),
  );
  assert.ok(assets.every(Boolean));
  const baseline = await api('getGenerationWorkspace', project.id);
  const workspace = structuredClone(baseline);
  const groupId = randomUUID();
  workspace.shots.push({
    id: randomUUID(),
    name: '救援后出现的镜头',
    position: { x: 100, y: 100 },
    viewport: { x: -20, y: 35, zoom: 0.75 },
    nodes: [
      {
        id: randomUUID(),
        type: 'text',
        text: '真实救援的独立文本\n第二行 📨',
        name: '救援文本',
        position: { x: 0, y: 0 },
        groupId,
      },
      ...assets.map((asset, index) => ({
        id: randomUUID(),
        type: 'asset',
        assetId: asset.id,
        textOverride: `救援覆盖文字 ${index}，不改原文件`,
        position: { x: 280 * (index + 1), y: 0 },
        groupId,
      })),
    ],
    groups: [
      {
        id: groupId,
        position: { x: 0, y: 0 },
        width: 850,
        height: 350,
        parameters: {
          model: 'seedance-2.0',
          ratio: '9:16',
          resolution: '1080p',
          duration: 8,
          generateAudio: true,
        },
      },
    ],
    labels: [
      {
        id: randomUUID(),
        name: '保留救援标签',
        color: '#f59e0b',
        pinned: true,
        position: { x: 0, y: 450 },
      },
    ],
  });
  const input = { sessionId: randomUUID(), seq: 1, baseline, workspace };
  assert.equal(
    await api('exportWorkspaceDraft', project.id, { snapshot: input }),
    exportPath,
  );
  const exportedRecord = JSON.parse(
    await fs.readFile(exportPath, 'utf8'),
  ).draft;
  assert.deepEqual(exportedRecord.workspace, workspace);
  assert.deepEqual(
    (await api('listWorkspaceDrafts', project.id)).drafts,
    [],
    'Exporting a snapshot does not create an active recovery stream',
  );
  const independent = await api('createProject', '救援不能覆盖的其他项目');
  const independentBaseline = await api(
    'getGenerationWorkspace',
    independent.project.id,
  );
  const unrelated = {
    sessionId: randomUUID(),
    seq: 3,
    baseline: independentBaseline,
    workspace: independentBaseline,
  };
  await api('protectWorkspaceDraft', independent.project.id, unrelated);
  const independentDrafts = await api(
    'listWorkspaceDrafts',
    independent.project.id,
  );
  assert.equal(independentDrafts.drafts.length, 1);
  await fs.writeFile(
    join(base, 'seed.json'),
    JSON.stringify(
      {
        project,
        snapshot: saved,
        assets,
        baseline,
        workspace,
        wanted: { ...workspace, revision: baseline.revision + 1 },
        exportedRecord,
        exportPath,
        independent,
        independentDrafts,
        independentFile: join(
          base,
          'projects',
          independent.project.folder,
          'project.sqlite',
        ),
        independentDraftFile: join(
          base,
          'profile',
          'workspace-drafts',
          `${independent.project.id}.${unrelated.sessionId}.json`,
        ),
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  assert.equal(exported, 1);
  console.log(
    'PASS configure: production public export contains actual text/parameters/group/asset references; original workspace remains saved baseline',
  );
}
async function openProject() {
  await waitFor(
    () =>
      run(
        `!![...document.querySelectorAll('button span')].find(s=>s.textContent.trim()===${JSON.stringify(seed.project.name)})`,
      ),
    'project home entry',
  );
  await run(
    `([...document.querySelectorAll('button span')].find(s=>s.textContent.trim()===${JSON.stringify(seed.project.name)})).closest('button').click()`,
  );
  await waitFor(
    () => run('!!document.querySelector("button[aria-label=返回项目首页]")'),
    'project canvas',
  );
}
async function verifyCommon() {
  assert.deepEqual(
    withoutTimestamp(await api('openProject', seed.project.id)),
    withoutTimestamp(seed.snapshot),
  );
  assert.deepEqual(
    await api('openProject', seed.independent.project.id),
    seed.independent,
  );
  assert.deepEqual(
    await api('listWorkspaceDrafts', seed.independent.project.id),
    seed.independentDrafts,
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(exportPath, 'utf8')).draft,
    seed.exportedRecord,
  );
}
async function importCopy() {
  await click('设置');
  await click('保存与存储');
  await click('导入恢复文件');
  await waitFor(
    () => run('!!document.querySelector("section[aria-label=恢复文件预览]")'),
    'real rescue preview',
  );
  assert.ok(
    await run(
      'document.querySelector("section[aria-label=恢复文件预览]").innerText.includes("整个镜头工作区")',
    ),
  );
  await click('取消预览');
  await waitFor(
    () => run('!document.querySelector("section[aria-label=恢复文件预览]")'),
    'cancelled preview',
  );
  assert.deepEqual(
    (await api('listWorkspaceDrafts', seed.project.id)).drafts,
    [],
  );
  assert.deepEqual(
    await api('getGenerationWorkspace', seed.project.id),
    seed.baseline,
  );
  await click('导入恢复文件');
  await click('导入为恢复副本');
  await waitFor(
    () =>
      run(
        'document.querySelector("section[aria-label=导入恢复文件]").innerText.includes("恢复副本已导入，原项目未改动。")',
      ),
    'import acknowledgement',
  );
  const listed = await api('listWorkspaceDrafts', seed.project.id);
  assert.equal(listed.drafts.length, 1);
  const record = listed.drafts[0];
  assert.match(record.sessionId, /^rescue-/);
  assert.deepEqual(record, {
    ...seed.exportedRecord,
    sessionId: record.sessionId,
    seq: 1,
  });
  assert.deepEqual(
    await api('getGenerationWorkspace', seed.project.id),
    seed.baseline,
    'Import cannot implicitly restore',
  );
  assert.equal(picked, 2);
  await fs.writeFile(join(base, 'imported.json'), JSON.stringify(record), {
    flag: 'wx',
  });
  await click('关闭');
  console.log(
    'PASS import: settings UI cancels without a record, then adds exactly one independent rescue copy without changing project/workspace',
  );
}
async function restore() {
  const record = JSON.parse(
    await fs.readFile(join(base, 'imported.json'), 'utf8'),
  );
  assert.deepEqual((await api('listWorkspaceDrafts', seed.project.id)).drafts, [
    record,
  ]);
  assert.deepEqual(
    await api('getGenerationWorkspace', seed.project.id),
    seed.baseline,
  );
  await openProject();
  await click('恢复镜头草稿');
  await waitFor(
    async () =>
      same(await api('getGenerationWorkspace', seed.project.id), seed.wanted),
    'explicit recovery committed exact workspace',
  );
  await waitFor(
    async () =>
      !(await api('listWorkspaceDrafts', seed.project.id)).drafts.length,
    'only restored copy acknowledged',
  );
  await click('返回项目首页');
  console.log(
    'PASS restore: separate process opens original project and explicitly restores exact text, group parameters, labels, ordering and references',
  );
}
async function reopen() {
  assert.deepEqual(
    await api('getGenerationWorkspace', seed.project.id),
    seed.wanted,
  );
  assert.deepEqual(
    (await api('listWorkspaceDrafts', seed.project.id)).drafts,
    [],
  );
  await openProject();
  await waitFor(
    () => run('document.body.innerText.includes("救援后出现的镜头")'),
    'saved restored shot visible',
  );
  await click('返回项目首页');
  console.log(
    `PASS ${mode}: restored workspace persists with no repeated recovery; unrelated project and recovery stream unchanged`,
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
    'loaded real home',
  );
  assert.equal(new URL(win.webContents.getURL()).protocol, 'file:');
  if (mode === 'configure') await configure();
  else {
    await verifyCommon();
    if (mode === 'import') await importCopy();
    else if (mode === 'restore') await restore();
    else await reopen();
    await verifyCommon();
  }
  assert.deepEqual(errors, []);
  complete = true;
  app.quit();
})().catch(async (error) => {
  console.error(error);
  console.error(JSON.stringify({ mode, errors, picked, exported }));
  if (win && !win.isDestroyed())
    console.error(
      await run('document.body.innerText').catch(() => 'renderer unavailable'),
    );
  exit(1);
});
