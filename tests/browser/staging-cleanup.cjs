// Production main/preload/renderer, real intake and real cleanup. Only the native chooser is supplied.
// Run after pnpm build: node tests/browser/staging-cleanup.cjs
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  writeSync,
} = require('node:fs');
const { join, resolve } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');
const {
  hash,
  withFixture,
  runElectron,
} = require('./reference-import-harness.cjs');

const root = resolve(__dirname, '../..');
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7);
const baseline = '57c753cb92893671ae0ae76c285563b189fbc1c8';
const size = 512 * 1024 * 1024;
const names = ['first.txt', 'cleanup-large.png', 'unstarted.txt'];
const text = '确认清理临时副本后，镜头内容仍可编辑和保存。';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function jobs(base) {
  const db = new DatabaseSync(join(base, 'profile', 'app.sqlite'), {
    readOnly: true,
  });
  try {
    return db
      .prepare('SELECT payload FROM saves')
      .all()
      .map((row) => JSON.parse(row.payload));
  } finally {
    db.close();
  }
}

async function verifyRetained(base, cleaned) {
  const old = JSON.parse(readFileSync(join(base, 'historical.json'), 'utf8'));
  assert.equal(old.commit, baseline);
  const current = jobs(base);
  for (const record of old.records) {
    assert.equal(
      await hash(record.file),
      record.sha256,
      'historical staging bytes stay unchanged',
    );
    assert.equal(
      await hash(record.source),
      record.sourceSha256,
      'historical source stays unchanged',
    );
    const job = current.find((entry) => entry.id === record.job.id);
    assert.ok(job, 'historical queue record must remain');
    assert.equal(
      job.status,
      'failed',
      'offline complete result remains failed, never falsely saved',
    );
    assert.equal(job.sha256, record.job.sha256);
    assert.equal(job.size, record.job.size);
  }
  assert.ok(existsSync(join(base, 'historical-project.sqlite.offline')));
  assert.equal(
    existsSync(join(base, 'projects', old.project.folder, 'project.sqlite')),
    false,
  );
  if (cleaned) {
    assert.equal(
      current.some((job) => job.id === cleaned.jobId),
      false,
    );
    assert.equal(existsSync(cleaned.file), false);
    assert.equal(
      current.some((job) => job.name === names[2]),
      false,
    );
    const first = current.find((job) => job.id === cleaned.firstId);
    assert.ok(first);
    assert.equal(first.status, 'saved');
    assert.ok(first.outputRelativePath);
    assert.equal(
      await hash(
        join(base, 'projects', cleaned.project.id, first.outputRelativePath),
      ),
      first.sha256,
      'the committed reference remains byte-identical',
    );
    assert.equal(await hash(join(base, 'inputs', names[0])), first.sha256);
    const db = new DatabaseSync(
      join(base, 'projects', cleaned.project.id, 'project.sqlite'),
      { readOnly: true },
    );
    try {
      const workspace = JSON.parse(
        db
          .prepare(
            "SELECT value FROM metadata WHERE key='generation-workspace'",
          )
          .get().value,
      );
      assert.equal(workspace.shots.length, 1);
      assert.deepEqual(
        workspace.shots[0].nodes
          .filter((node) => node.type === 'asset')
          .map((node) => node.assetId),
        [first.id],
      );
      assert.equal(
        workspace.shots[0].nodes.find((node) => node.type === 'text')?.text,
        text,
      );
    } finally {
      db.close();
    }
  }
}

async function harness() {
  const electron = require('electron');
  assert.equal(typeof electron, 'string', 'Run this harness with Node');
  assert.ok(
    existsSync(join(root, 'out/main/index.js')),
    'Build production output first',
  );
  await withFixture('afflatus-staging-cleanup-', async (base, log) => {
    for (const name of ['profile', 'projects', 'inputs', 'old-code'])
      mkdirSync(join(base, name));
    // Explicit immutable provenance, including on CI. A shallow checkout must fail, never use current code.
    execFileSync(
      'git',
      [
        'archive',
        '--format=tar',
        `--output=${join(base, 'history.tar')}`,
        baseline,
        'package.json',
        'src/main',
        'src/shared',
      ],
      { cwd: root },
    );
    execFileSync('tar', ['-xf', '../history.tar'], {
      cwd: join(base, 'old-code'),
    });
    execFileSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(require.resolve('tsx')).href,
        join(__dirname, 'staging-cleanup-seed.mjs'),
        base,
        join(base, 'old-code'),
        baseline,
      ],
      { cwd: root, stdio: 'inherit', timeout: 30000 },
    );
    writeFileSync(
      join(base, 'inputs', names[0]),
      '清理不能删除已完整导入的文本参考。',
      { flag: 'wx' },
    );
    writeFileSync(
      join(base, 'inputs', names[2]),
      '取消后不应开始的第三份输入。',
      { flag: 'wx' },
    );
    const fd = openSync(join(base, 'inputs', names[1]), 'wx');
    try {
      ftruncateSync(fd, size);
      writeSync(fd, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    } finally {
      closeSync(fd);
    }
    const sources = names.map((name) => join(base, 'inputs', name));
    const before = await Promise.all(sources.map(hash));
    await runElectron(electron, __filename, base, ['--mode=cleanup'], log);
    const cleaned = JSON.parse(
      readFileSync(join(base, 'cleaned.json'), 'utf8'),
    );
    await verifyRetained(base, cleaned);
    await runElectron(electron, __filename, base, ['--mode=reopen'], log);
    await verifyRetained(base, cleaned);
    assert.deepEqual(
      await Promise.all(sources.map(hash)),
      before,
      'entire source files stay byte-identical',
    );
    console.log(
      'PASS cleanup and fresh-process reopening preserve original hashes, completed reference, fixed historical partial and complete ready result; removed intake never becomes a saved job',
    );
  });
}

async function electronCase() {
  const { app, BrowserWindow, dialog } = require('electron');
  const base = process.argv
    .find((arg) => arg.startsWith('--scratch='))
    ?.slice(10);
  assert.ok(base && ['cleanup', 'reopen'].includes(mode));
  assert.equal(realpathSync.native(base), base);
  assert.equal(process.env.AFFLATUS_USER_DATA, join(base, 'profile'));
  assert.equal(process.env.AFFLATUS_PROJECTS_DIR, join(base, 'projects'));
  assert.ok(existsSync(join(base, '.fixture-owner')));
  const exit = app.exit.bind(app);
  let complete = false;
  app.exit = (code = 0) => exit(complete && code === 0 ? 0 : 1);
  const errors = [];
  let pickerCalls = 0;
  dialog.showOpenDialog = async (_window, options) => {
    assert.equal(mode, 'cleanup');
    assert.equal(options.title, '添加参考素材');
    pickerCalls++;
    return {
      canceled: false,
      filePaths: names.map((name) => join(base, 'inputs', name)),
    };
  };
  dialog.showMessageBox = async (_window, options) => {
    const value = options ?? _window;
    errors.push(`Unexpected dialog: ${value.message}`);
    return {
      response: value.cancelId ?? value.buttons.length - 1,
      checkboxChecked: false,
    };
  };
  dialog.showErrorBox = (title, message) => {
    errors.push(`${title}: ${message}`);
  };
  app.on('browser-window-created', (_event, win) => {
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', (details) => {
      if (details.level === 'error') {
        errors.push(details.message);
        console.error('Renderer:', details.message);
      }
    });
    let painting = false;
    const timer = setInterval(async () => {
      if (painting || win.isDestroyed()) return;
      painting = true;
      try {
        await win.webContents.capturePage();
      } catch {
        /* Window may close during capture. */
      } finally {
        painting = false;
      }
    }, 100);
    win.once('closed', () => clearInterval(timer));
  });
  async function waitFor(check, label) {
    const end = Date.now() + 30000;
    while (Date.now() < end) {
      assert.deepEqual(errors, [], label);
      if (await check()) return;
      await sleep(40);
    }
    throw new Error(`Timed out: ${label}`);
  }
  try {
    await import(pathToFileURL(join(root, 'out/main/index.js')).href);
    await waitFor(
      () => BrowserWindow.getAllWindows().length === 1,
      'main window',
    );
    const win = BrowserWindow.getAllWindows()[0];
    const run = (code) => win.webContents.executeJavaScript(code);
    const click = async (label) => {
      const query = `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)} && !b.closest('[inert]') && b.getClientRects().length)`;
      await waitFor(
        () => run(`(() => {const b=${query};return !!b&&!b.disabled})()`),
        `enabled button ${label}`,
      );
      await run(`(${query}).click()`);
    };
    await waitFor(
      () => run(`!!document.querySelector('input[aria-label="新项目名称"]')`),
      'project home',
    );
    assert.equal(new URL(win.webContents.getURL()).protocol, 'file:');
    const state = () => run('window.desktop.getLibrary()');
    assert.equal((await state()).root, join(base, 'projects'));
    await run(
      `(() => {window.unavailable=[];new MutationObserver(()=>{const n=document.querySelector('[data-project-unavailable]');if(n)window.unavailable.push(n.textContent)}).observe(document.body,{subtree:true,childList:true,characterData:true});})()`,
    );
    let evidence;
    let project;
    if (mode === 'cleanup') {
      await click('新建项目');
      await click('新建镜头');
      project = (await state()).projects.find(
        (entry) => entry.name !== '历史暂存保护夹具',
      );
      assert.ok(project);
      await run(`(() => {
        window.cancelProgress=null;
        window.desktop.onReferenceImportProgress(progress=>{
          if(window.cancelProgress || progress.phase!=='receiving' || progress.fileIndex!==2 || progress.receivedBytes<=0)return;
          if(progress.receivedBytes>=progress.fileBytes)throw new Error('Large input completed before cancellation');
          const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='取消导入'&&!b.closest('[inert]'));
          if(!button||button.disabled)throw new Error('Cancel button unavailable during receive');
          window.cancelProgress=progress;button.click();
        });
      })()`);
      await click('导入素材');
      await waitFor(
        () =>
          run(
            `document.querySelector('section[aria-label$="素材子画布"]')?.textContent.includes('已取消导入。已添加 1 个素材，2 个未完成。')`,
          ),
        'real intake cancellation settles',
      );
      const progress = await run('window.cancelProgress');
      assert.ok(
        progress && progress.receivedBytes > 0 && progress.receivedBytes < size,
      );
      assert.equal(pickerCalls, 1);
      await waitFor(
        async () =>
          (await state()).jobs.find((job) => job.name === names[0])?.status ===
          'saved',
        'completed reference saved',
      );
      const current = (await state()).jobs;
      const cancelled = current.find((job) => job.name === names[1]);
      const first = current.find((job) => job.name === names[0]);
      assert.ok(cancelled && first);
      assert.equal(cancelled.status, 'failed');
      assert.equal(cancelled.error, '接收结果已取消');
      const file = join(base, 'profile', 'staging', `${cancelled.id}.part`);
      const bytes = statSync(file).size;
      assert.ok(bytes > 0 && bytes < size);
      const originalHash = await hash(file);
      evidence = {
        project,
        jobId: cancelled.id,
        firstId: first.id,
        file,
        bytes,
        progress,
      };
      await verifyRetained(base);
      await click('返回主画布');
      await waitFor(
        () =>
          run(`!document.querySelector('section[aria-label$="素材子画布"]')`),
        'material canvas closed before opening global settings',
      );
      await click('管理暂存');
      await click('检查未完成导入');
      await waitFor(
        () =>
          run(
            `document.querySelector('section[aria-label="暂存清理预览"]')?.textContent.includes('可清理 1 个临时文件')`,
          ),
        'preview has exactly one owned file',
      );
      const previewText = await run(
        `document.querySelector('section[aria-label="暂存清理预览"]').textContent`,
      );
      assert.ok(previewText.includes(names[1]));
      assert.ok(previewText.includes(bytes.toLocaleString('zh-CN')));
      assert.ok(previewText.includes('historical-partial.txt'));
      assert.ok(previewText.includes('historical-ready.txt'));
      await click('暂不清理');
      await waitFor(
        () =>
          run(`!document.querySelector('section[aria-label="暂存清理预览"]')`),
        'cancel dismisses preview',
      );
      assert.equal(await hash(file), originalHash);
      assert.deepEqual(
        (await state()).jobs.find((job) => job.id === cancelled.id),
        cancelled,
      );
      await verifyRetained(base);
      console.log(
        `PASS preview cancellation preserves ${bytes} received bytes and queue record; both historical entries are retained`,
      );
      await click('检查未完成导入');
      await click('清理 1 个临时文件');
      await waitFor(
        () =>
          run(
            `document.querySelector('section[aria-label="未完成导入暂存"]')?.textContent.includes('上次清理：已清理 1 个临时文件')`,
          ),
        'explicit cleanup result',
      );
      assert.equal(existsSync(file), false);
      assert.equal(
        (await state()).jobs.some((job) => job.id === cancelled.id),
        false,
      );
      await verifyRetained(base);
      await click('重新检查');
      await waitFor(
        () =>
          run(
            `document.querySelector('section[aria-label="暂存清理预览"]')?.textContent.includes('没有可安全清理的临时文件')`,
          ),
        'legacy entries cannot be claimed',
      );
      await run(
        `document.querySelector('dialog[open] button[aria-label="关闭"]').click()`,
      );
      await waitFor(
        () => run(`!document.querySelector('dialog[open]')`),
        'settings closed',
      );
      await click('素材画布');
      await click('文本');
      await waitFor(
        () =>
          run(
            `!!document.querySelector('textarea[aria-label="文本卡片内容"]')`,
          ),
        'text card',
      );
      await run(
        `document.querySelector('textarea[aria-label="文本卡片内容"]').focus({preventScroll:true})`,
      );
      await win.webContents.insertText(text);
      writeFileSync(join(base, 'cleaned.json'), JSON.stringify(evidence), {
        flag: 'wx',
      });
      console.log(
        `PASS explicit confirmation removes only owned unfinished intake (${bytes} bytes); source and complete ready remain`,
      );
    } else {
      evidence = JSON.parse(readFileSync(join(base, 'cleaned.json'), 'utf8'));
      project = evidence.project;
      await run(
        `(() => {const button=[...document.querySelectorAll('li button')].find(b=>b.textContent.includes(${JSON.stringify(project.name)}));if(!button||button.disabled)throw new Error('Saved project missing');button.click()})()`,
      );
      assert.equal(
        (await state()).jobs.some((job) => job.id === evidence.jobId),
        false,
      );
      await click('管理暂存');
      await click('检查未完成导入');
      await waitFor(
        () =>
          run(
            `document.querySelector('section[aria-label="暂存清理预览"]')?.textContent.includes('没有可安全清理的临时文件')`,
          ),
        'restart does not adopt legacy files',
      );
      await run(
        `document.querySelector('dialog[open] button[aria-label="关闭"]').click()`,
      );
      await waitFor(
        () => run(`!document.querySelector('dialog[open]')`),
        'settings closed',
      );
      await click('素材画布');
    }
    const workspace = () =>
      run(
        `window.desktop.getGenerationWorkspace(${JSON.stringify(project.id)})`,
      );
    await waitFor(
      async () =>
        (await workspace()).shots[0]?.nodes.find((node) => node.type === 'text')
          ?.text === text,
      'text edit durable',
    );
    assert.deepEqual(
      (await workspace()).shots[0].nodes
        .filter((node) => node.type === 'asset')
        .map((node) => node.assetId),
      [evidence.firstId],
    );
    await click('返回主画布');
    await waitFor(
      () => run(`!document.querySelector('section[aria-label$="素材子画布"]')`),
      'main canvas',
    );
    await run(
      `document.querySelector('button[aria-label="返回项目首页"]').click()`,
    );
    await waitFor(
      () => run(`!!document.querySelector('input[aria-label="新项目名称"]')`),
      'home after safe save',
    );
    assert.deepEqual(await run('window.unavailable'), []);
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${mode}: completed reference and edited text persist, cleanup never turns removed intake into a saved result`,
    );
    complete = true;
    app.quit();
  } catch (error) {
    console.error(error);
    exit(1);
  }
}

(mode ? electronCase() : harness()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
