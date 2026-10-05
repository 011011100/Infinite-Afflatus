const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const archiveName = '完整 项目包.afflatus';
const finalText = '独立文本；返回前编辑；原生关闭前编辑';
const packagePath = (c, name = archiveName) => join(c.base, 'external', name);
const workspace = (c) => c.api('getGenerationWorkspace', c.seed.project.id);
const events = (c) => c.run('window.packageEvents');
async function resetEvents(c) {
  await c.run('window.packageEvents=[]');
}
async function terminal(c, operation, phase) {
  return c.waitFor(
    async () =>
      (await events(c)).find(
        (event) => event.operation === operation && event.phase === phase,
      ),
    `${operation} ${phase}`,
  );
}
async function positive(c, operation, requireVisibleProgress = true) {
  const event = await c.waitFor(
    async () =>
      (await events(c)).find(
        (value) =>
          value.operation === operation &&
          value.phase === 'copying' &&
          value.completedBytes >= 1024 ** 2 &&
          value.totalBytes > value.completedBytes &&
          value.fileName?.endsWith('.wav'),
      ),
    `${operation} real partial copy progress`,
  );
  assert.equal(event.canCancel, true);
  assert.ok(
    c.delayedBytes() > 0,
    'Positive progress must follow an actual fixture-local package write',
  );
  if (requireVisibleProgress) {
    await c.waitFor(
      () =>
        c.run(
          `(() => {const p=document.querySelector('section[aria-label="项目包进度"] progress[aria-label="项目包已写入字节"]');return !!p && p.value>0 && p.value<p.max && p.max===${event.totalBytes};})()`,
        ),
      `${operation} visible real byte progress`,
    );
  }
  return event;
}
async function openProject(c) {
  await c.waitFor(
    () =>
      c.run(
        `!![...document.querySelectorAll('button span')].find(s=>s.textContent.trim()===${JSON.stringify(c.seed.project.name)})`,
      ),
    'project home entry',
  );
  assert.equal(
    await c.run(
      `[...document.querySelectorAll('button span')].filter(s=>s.textContent.trim()===${JSON.stringify(c.seed.project.name)}).length`,
    ),
    1,
    'The source project name must identify exactly one UI entry',
  );
  await c.run(
    `([...document.querySelectorAll('button span')].find(s=>s.textContent.trim()===${JSON.stringify(c.seed.project.name)})).closest('button').click()`,
  );
  await c.waitFor(
    () => c.run('!!document.querySelector("button[aria-label=返回项目首页]")'),
    'source canvas',
  );
  assert.equal(
    await c.run(
      'document.querySelector("button[title=修改项目名称]").textContent.trim()',
    ),
    c.seed.project.name,
  );
  assert.equal(
    (await c.api('getLibrary')).projects.length,
    c.mode === 'roundtrip' ? 2 : 4,
  );
}
async function closeDialog(c) {
  await c.click('关闭');
  await c.waitFor(
    () => c.run('!document.querySelector("dialog[open]")'),
    'package dialog closed',
  );
}
async function home(c) {
  await c.click('返回项目首页');
  await c.waitFor(
    () => c.run('!!document.querySelector("input[aria-label=新项目名称]")'),
    'returned home',
  );
}
async function assertClean(c) {
  for (const directory of ['profile', 'projects', 'external'])
    assert.deepEqual(
      (await fs.readdir(join(c.base, directory))).filter(
        (name) =>
          name.startsWith('.afflatus-package-') || name.endsWith('.part'),
      ),
      [],
      'Owned package work must be removed before cancel returns',
    );
  const db = new DatabaseSync(join(c.base, 'profile', 'app.sqlite'), {
    readOnly: true,
  });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'project-package-work'")
      .get();
    assert.deepEqual(
      row ? JSON.parse(row.value) : [],
      [],
      'Successful/cancelled work leaves no recovery authorization',
    );
  } finally {
    db.close();
  }
}
async function verifyCopies(c) {
  const copies = JSON.parse(
    await fs.readFile(join(c.base, 'copies.json'), 'utf8'),
  );
  for (const copy of copies) {
    assert.deepEqual(await c.api('openProject', copy.project.id), copy);
    assert.deepEqual(
      await c.api('getGenerationWorkspace', copy.project.id),
      c.seed.workspace,
    );
    for (const asset of copy.assets)
      assert.equal(
        await c.hash(
          join(c.base, 'projects', copy.project.folder, asset.relativePath),
        ),
        asset.sha256,
      );
  }
  assert.equal((await c.api('getLibrary')).projects.length, 4);
  assert.deepEqual(
    await c.api('openProject', c.seed.independent.project.id),
    c.seed.independent,
  );
}

async function configure(c) {
  const snapshot = await c.api('createProject', '真实项目包进度项目');
  const project = snapshot.project;
  c.setChoice({
    title: '添加参考素材',
    paths: [join(c.base, '合法 静音.wav'), join(c.base, '原文.txt')],
  });
  const refs = await c.api('importReferences', project.id, c.randomUUID());
  assert.equal(refs.assetIds.length, 2);
  assert.deepEqual(refs.errors, []);
  await c.waitFor(
    async () =>
      (await c.api('getLibrary')).jobs.every((job) => job.status === 'saved'),
    'reference save queue committed',
  );
  const source = await c.api('openProject', project.id);
  assert.deepEqual(source.assets.map((asset) => asset.kind).sort(), [
    'audio',
    'text',
  ]);
  const baseline = await c.api('getGenerationWorkspace', project.id);
  const groupId = c.randomUUID();
  const draft = structuredClone(baseline);
  draft.shots.push({
    id: c.randomUUID(),
    name: '含原文、音频与生成组的镜头',
    position: { x: 100, y: 100 },
    viewport: { x: 25, y: 25, zoom: 0.8 },
    nodes: [
      {
        id: c.randomUUID(),
        type: 'text',
        text: '独立文本',
        name: '关闭保存验收',
        position: { x: 0, y: 0 },
      },
      {
        id: c.randomUUID(),
        type: 'text',
        text: '组合文本与参数保持',
        name: '组合文本',
        groupId,
        position: { x: 0, y: 0 },
      },
      ...source.assets.map((asset, index) => ({
        id: c.randomUUID(),
        type: 'asset',
        assetId: asset.id,
        position: { x: 280 * (index + 1), y: 0 },
        groupId,
        ...(asset.kind === 'text'
          ? { textOverride: '项目内覆写，不修改源文件' }
          : {}),
      })),
    ],
    groups: [
      {
        id: groupId,
        position: { x: 400, y: 0 },
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
        id: c.randomUUID(),
        name: '项目包保留标签',
        color: '#f59e0b',
        pinned: true,
        position: { x: 0, y: 450 },
      },
    ],
  });
  const saved = await c.api('saveGenerationWorkspace', project.id, draft);
  const independent = await c.api('createProject', '不得更改的独立项目');
  await fs.writeFile(
    join(c.base, 'seed.json'),
    JSON.stringify(
      {
        project,
        snapshot: await c.api('openProject', project.id),
        workspace: saved,
        independent,
      },
      null,
      2,
    ),
    { flag: 'wx' },
  );
  console.log(
    'PASS package configure: valid 32 MiB PCM media + original text + text override + group parameters + label, saved through production IPC',
  );
}

async function roundtrip(c) {
  await openProject(c);
  await c.click('项目备份');
  c.setThrottle(true);
  await resetEvents(c);
  c.setChoice({ title: '导出项目包', path: packagePath(c) });
  await c.click('导出项目包');
  await positive(c, 'export');
  await c.run(
    'new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))',
  );
  const screenshot = join(tmpdir(), 'afflatus-project-package-progress.png');
  await fs.writeFile(
    screenshot,
    (await c.window.webContents.capturePage()).toPNG(),
  );
  console.log(`Package progress screenshot: ${screenshot}`);
  await terminal(c, 'export', 'completed');
  await c.waitFor(
    () => c.run(`!${c.button('导出项目包')}.disabled`),
    'export UI settled',
  );
  assert.ok((await fs.stat(packagePath(c))).size > 32 * 1024 ** 2);
  await resetEvents(c);
  await c.click('创建副本');
  await positive(c, 'duplicate');
  await terminal(c, 'duplicate', 'completed');
  await closeDialog(c);
  await home(c);
  await resetEvents(c);
  c.setChoice({ title: '导入项目包', path: packagePath(c) });
  await c.click('导入项目包');
  await positive(c, 'import');
  await terminal(c, 'import', 'completed');
  await c.waitFor(
    async () => (await c.api('getLibrary')).projects.length === 4,
    'independent imported project',
  );
  const projects = (await c.api('getLibrary')).projects.filter(
    (project) =>
      ![c.seed.project.id, c.seed.independent.project.id].includes(project.id),
  );
  assert.equal(projects.length, 2);
  assert.equal(
    projects.filter((project) => project.name === c.seed.project.name).length,
    1,
    'The imported archive preserves its source project name',
  );
  const copies = [];
  for (const project of projects) {
    const copy = await c.api('openProject', project.id);
    assert.notEqual(copy.project.id, c.seed.project.id);
    assert.equal(copy.project.folder, copy.project.id);
    assert.deepEqual(copy.assets, c.seed.snapshot.assets);
    assert.deepEqual(copy.canvas, c.seed.snapshot.canvas);
    assert.deepEqual(copy.viewport, c.seed.snapshot.viewport);
    assert.deepEqual(
      await c.api('getGenerationWorkspace', project.id),
      c.seed.workspace,
    );
    // Import intentionally preserves the original name. Give that already-verified
    // copy a unique fixture name before later UI tests select the source project.
    if (copy.project.name === c.seed.project.name) {
      assert.equal(project.name, c.seed.project.name);
      await c.api('renameProject', project.id, '已核验的项目包导入副本');
      copies.push(await c.api('openProject', project.id));
    } else copies.push(copy);
  }
  await fs.writeFile(
    join(c.base, 'copies.json'),
    JSON.stringify(copies, null, 2),
    { flag: 'wx' },
  );
  await assertClean(c);
  console.log(
    'PASS package roundtrip: real UI export/import/duplicate show positive byte progress; new IDs preserve canvas, source assets and complete grouped workspace',
  );
}

async function cancelled(c) {
  c.setThrottle(true);
  await openProject(c);
  await c.click('项目备份');
  for (const operation of ['export', 'duplicate']) {
    await resetEvents(c);
    if (operation === 'export')
      c.setChoice({
        title: '导出项目包',
        path: packagePath(c, '取消导出.afflatus'),
      });
    await c.click(operation === 'export' ? '导出项目包' : '创建副本');
    const progress = await positive(c, operation);
    assert.ok(
      await c.run('!!document.querySelector("section[aria-label=项目包进度]")'),
    );
    await c.click('取消项目包操作');
    await terminal(c, operation, 'cancelled');
    await c.api('cancelProjectPackage', progress.requestId);
    await assertClean(c);
    assert.equal((await c.api('getLibrary')).projects.length, 4);
  }
  await closeDialog(c);
  await home(c);
  await resetEvents(c);
  c.setChoice({ title: '导入项目包', path: packagePath(c) });
  await c.click('导入项目包');
  const progress = await positive(c, 'import');
  await c.click('取消项目包操作');
  await terminal(c, 'import', 'cancelled');
  await c.api('cancelProjectPackage', progress.requestId);
  await assertClean(c);
  for (const operation of ['export', 'import']) {
    const requestId = c.randomUUID();
    const path =
      operation === 'export'
        ? packagePath(c, '迟到选择.afflatus')
        : packagePath(c);
    c.setChoice({
      title: operation === 'export' ? '导出项目包' : '导入项目包',
      path,
      deferred: true,
    });
    const args =
      operation === 'export' ? [c.seed.project.id, requestId] : [requestId];
    await c.run(
      `window.latePackageDone=false; window.latePackageResult='pending'; window.latePackageError=null; void window.desktop.${operation}ProjectPackage(${args.map((arg) => JSON.stringify(arg)).join(',')}).then(value=>{window.latePackageResult=value;window.latePackageDone=true},error=>{window.latePackageError=String(error);window.latePackageDone=true});`,
    );
    await c.waitFor(c.pickerPending, `${operation} native picker pending`);
    await c.api('cancelProjectPackage', requestId);
    await c.releasePicker();
    await c.waitFor(
      () => c.run('window.latePackageDone'),
      'cancelled late chooser result',
    );
    assert.equal(await c.run('window.latePackageError'), null);
    assert.equal(await c.run('window.latePackageResult'), null);
    await assertClean(c);
    assert.equal((await c.api('getLibrary')).projects.length, 4);
  }
  for (const name of ['取消导出.afflatus', '迟到选择.afflatus'])
    await assert.rejects(fs.stat(packagePath(c, name)), { code: 'ENOENT' });
  await verifyCopies(c);
  console.log(
    'PASS package cancellation: export/import/duplicate stop after real partial writes; late native selections return null without publication; own work cleaned and existing projects retained',
  );
}

async function leave(c) {
  await openProject(c);
  await c.click('素材画布');
  await c.waitFor(
    () =>
      c.run('!!document.querySelector("textarea[aria-label=文本卡片内容]")'),
    'editable shot text',
  );
  c.setThrottle(true);
  await resetEvents(c);
  const requestId = c.randomUUID();
  // This production preload call keeps the shot editor visible for a real input;
  // it bypasses only the backup modal, never the main operation or leave handler.
  await c.run(
    `window.leavePackageDone=false; window.leavePackageResult='pending'; window.leavePackageError=null; void window.desktop.duplicateProject(${JSON.stringify(c.seed.project.id)},${JSON.stringify(requestId)}).then(value=>{window.leavePackageDone=true;window.leavePackageResult=value},error=>{window.leavePackageDone=true;window.leavePackageError=String(error)});`,
  );
  await positive(c, 'duplicate', false);
  const suffix = c.mode === 'leave-home' ? '；返回前编辑' : '；原生关闭前编辑';
  const previous =
    c.mode === 'leave-home' ? '独立文本' : '独立文本；返回前编辑';
  c.window.focus();
  await c.run(
    `(() => {const t=[...document.querySelectorAll('textarea[aria-label=文本卡片内容]')].find(t=>t.value===${JSON.stringify(previous)});if(!t || t.disabled || t.readOnly)throw new Error('Independent text input is unavailable');t.focus({preventScroll:true});t.setSelectionRange(t.value.length,t.value.length);if(document.activeElement!==t)throw new Error('Text focus was not acquired');})()`,
  );
  await c.window.webContents.insertText(suffix);
  await c.waitFor(
    () =>
      c.run(
        `[...document.querySelectorAll('textarea[aria-label=文本卡片内容]')].some(t=>t.value===${JSON.stringify(previous + suffix)})`,
      ),
    'real dirty input is present before leaving',
  );
  assert.equal(
    await c.run('window.leavePackageDone'),
    false,
    'Copy must still own the gate while dirty input is created',
  );
  if (c.mode === 'leave-close') {
    c.allowNativeClose();
    c.window.close();
    await c.waitFor(
      () => c.window.isDestroyed(),
      'native close cancels copy then flushes the dirty workspace',
    );
    console.log(
      'PASS package native close: positive-byte copy active at last input; production close handshake completed',
    );
    return;
  }
  await c.click('返回主画布');
  await c.waitFor(
    () => c.run('!document.querySelector("section[aria-label$=素材子画布]")'),
    'shot leave after copy cancellation',
  );
  await home(c);
  await c.waitFor(
    () => c.run('window.leavePackageDone'),
    'copy request settled before leaving',
  );
  assert.equal(await c.run('window.leavePackageError'), null);
  assert.equal(await c.run('window.leavePackageResult'), null);
  assert.equal(
    (await workspace(c)).shots[0].nodes[0].text,
    '独立文本；返回前编辑',
  );
  await assertClean(c);
  console.log(
    'PASS package dirty return: copy cancelled and temporary files reclaimed before workspace save and return home',
  );
}

async function exercise(c) {
  if (c.mode === 'roundtrip') return roundtrip(c);
  if (c.mode === 'cancel') return cancelled(c);
  if (c.mode.startsWith('leave-')) return leave(c);
  await verifyCopies(c);
  const actual = await workspace(c);
  assert.equal(actual.shots[0].nodes[0].text, finalText);
  const expected = structuredClone(c.seed.workspace);
  expected.revision = actual.revision;
  expected.shots[0].nodes[0].text = finalText;
  assert.deepEqual(
    actual,
    expected,
    'Only intended dirty text and revision may change',
  );
  assert.deepEqual(
    (await c.api('listWorkspaceDrafts', c.seed.project.id)).drafts,
    [],
  );
  await assertClean(c);
  console.log(
    `PASS package ${c.mode}: dirty text durable, groups/parameters/references preserved, cancelled requests not replayed and two successful copies remain independent`,
  );
}

module.exports = { configure, exercise };
