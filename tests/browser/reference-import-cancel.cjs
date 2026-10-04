// Production main/preload/renderer with real file intake; only native file selection is supplied.
// Run after pnpm build: node tests/browser/reference-import-cancel.cjs
const assert = require('node:assert/strict');
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
const size = 512 * 1024 * 1024;
const names = ['first.txt', 'cancel-large.png', 'unstarted.txt'];
const text = '取消大文件导入后仍能继续编辑和保存。';
const marker = 'REFERENCE_IMPORT_POSITIVE_BYTES:';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function verifyStored(base, scenario) {
  const evidence = JSON.parse(
    readFileSync(join(base, 'evidence.json'), 'utf8'),
  );
  assert.equal(evidence.progress.fileIndex, 2);
  assert.equal(evidence.progress.phase, 'receiving');
  assert.ok(
    evidence.progress.receivedBytes > 0 &&
      evidence.progress.receivedBytes < size,
    'must cancel real intake in progress, never an unstarted or complete file',
  );
  const db = new DatabaseSync(join(base, 'profile', 'app.sqlite'), {
    readOnly: true,
  });
  let jobs;
  try {
    jobs = db
      .prepare('SELECT payload FROM saves')
      .all()
      .map((row) => JSON.parse(row.payload));
  } finally {
    db.close();
  }
  assert.equal(jobs.length, 2, 'the third file must not create a job');
  const first = jobs.find((job) => job.name === names[0]);
  const cancelled = jobs.find((job) => job.name === names[1]);
  assert.ok(first && cancelled);
  assert.ok(['ready', 'saving', 'saved'].includes(first.status));
  assert.equal(cancelled.status, 'failed');
  assert.equal(cancelled.error, '接收结果已取消');
  const partial = statSync(
    join(base, 'profile', 'staging', `${cancelled.id}.part`),
  );
  assert.ok(
    partial.size > 0 && partial.size < size,
    'only incomplete received bytes remain in staging',
  );
  assert.equal(
    existsSync(join(base, 'profile', 'staging', `${cancelled.id}.ready`)),
    false,
  );
  const projectDb = new DatabaseSync(
    join(base, 'projects', evidence.project.id, 'project.sqlite'),
    { readOnly: true },
  );
  let workspace;
  try {
    workspace = JSON.parse(
      projectDb
        .prepare("SELECT value FROM metadata WHERE key='generation-workspace'")
        .get().value,
    );
  } finally {
    projectDb.close();
  }
  assert.equal(workspace.shots.length, 1);
  const references = workspace.shots[0].nodes.filter(
    (node) => node.type === 'asset',
  );
  assert.deepEqual(
    references.map((node) => node.assetId),
    [first.id],
  );
  assert.equal(
    workspace.shots[0].nodes.filter((node) => node.type === 'text').length,
    scenario === 'button' ? 1 : 0,
  );
  console.log(
    `PASS ${scenario}: SQLite retains only the completed reference, unfinished .part remains (${partial.size} bytes), third file never starts`,
  );
}

async function harness() {
  const electron = require('electron');
  assert.equal(typeof electron, 'string', 'Run this harness with Node');
  assert.ok(
    existsSync(join(root, 'out/main/index.js')),
    'Build production output first',
  );
  for (const scenario of ['button', 'native-close']) {
    await withFixture('afflatus-reference-cancel-', async (base, log) => {
      for (const name of ['profile', 'projects', 'inputs'])
        mkdirSync(join(base, name));
      writeFileSync(
        join(base, 'inputs', names[0]),
        '完整接收的第一份参考文本。',
      );
      writeFileSync(
        join(base, 'inputs', names[2]),
        '取消后不能开始的第三份文本。',
      );
      const large = openSync(join(base, 'inputs', names[1]), 'wx');
      try {
        ftruncateSync(large, size);
        writeSync(
          large,
          Buffer.from('large synthetic cancellation fixture'),
          0,
          36,
          0,
        );
        writeSync(
          large,
          Buffer.from('unchanged final bytes'),
          0,
          21,
          size - 21,
        );
      } finally {
        closeSync(large);
      }
      const sources = names.map((name) => join(base, 'inputs', name));
      const before = await Promise.all(sources.map(hash));
      await runElectron(
        electron,
        __filename,
        base,
        [`--mode=import`, `--scenario=${scenario}`],
        log,
      );
      verifyStored(base, scenario);
      await runElectron(
        electron,
        __filename,
        base,
        [`--mode=reopen`, `--scenario=${scenario}`],
        log,
      );
      assert.deepEqual(
        await Promise.all(sources.map(hash)),
        before,
        'all original bytes, including the entire large file, remain unchanged',
      );
      console.log(
        `PASS ${scenario}: fresh production process reopens the saved shot and all original SHA-256 values remain unchanged`,
      );
    });
  }
}

async function electronCase() {
  const { app, BrowserWindow, dialog } = require('electron');
  const base = process.argv
    .find((arg) => arg.startsWith('--scratch='))
    ?.slice(10);
  const scenario = process.argv
    .find((arg) => arg.startsWith('--scenario='))
    ?.slice(11);
  assert.ok(base && ['button', 'native-close'].includes(scenario));
  assert.equal(realpathSync.native(base), base);
  assert.equal(process.env.AFFLATUS_USER_DATA, join(base, 'profile'));
  assert.equal(process.env.AFFLATUS_PROJECTS_DIR, join(base, 'projects'));
  assert.ok(existsSync(join(base, '.fixture-owner')));
  const exit = app.exit.bind(app);
  let complete = false;
  app.exit = (code = 0) => exit(complete && code === 0 ? 0 : 1);
  let win;
  let project;
  let evidence;
  let pickerCalls = 0;
  const errors = [];
  dialog.showOpenDialog = async (_window, options) => {
    assert.equal(mode, 'import');
    assert.equal(options.title, '添加参考素材');
    pickerCalls += 1;
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
    console.error(title, message);
  };
  app.on('browser-window-created', (_event, window) => {
    window.webContents.setBackgroundThrottling(false);
    window.webContents.on('console-message', (details) => {
      if (details.level === 'error') {
        errors.push(details.message);
        console.error('Renderer:', details.message);
      }
      if (details.message.startsWith(marker)) {
        try {
          assert.equal(
            evidence,
            undefined,
            'cancellation triggers exactly once',
          );
          const progress = JSON.parse(details.message.slice(marker.length));
          assert.ok(
            project &&
              progress.fileIndex === 2 &&
              progress.phase === 'receiving' &&
              progress.receivedBytes > 0 &&
              progress.receivedBytes < size,
          );
          evidence = { project, progress };
          writeFileSync(join(base, 'evidence.json'), JSON.stringify(evidence), {
            flag: 'wx',
          });
          if (scenario === 'native-close') window.close();
        } catch (error) {
          errors.push(String(error));
          console.error(error);
          exit(1);
        }
      }
    });
    let painting = false;
    const timer = setInterval(async () => {
      if (painting || window.isDestroyed()) return;
      painting = true;
      try {
        await window.webContents.capturePage();
      } catch {
        /* Window can close during capture. */
      } finally {
        painting = false;
      }
    }, 100);
    window.once('closed', () => clearInterval(timer));
  });
  async function waitFor(check, label) {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
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
    win = BrowserWindow.getAllWindows()[0];
    const run = (code) => win.webContents.executeJavaScript(code);
    const click = async (label) => {
      const query = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.closest('[inert]'))`;
      await waitFor(
        () => run(`(() => { const b=${query}; return !!b && !b.disabled; })()`),
        `enabled button: ${label}`,
      );
      await run(`(${query}).click()`);
    };
    await waitFor(
      () => run(`!!document.querySelector('input[aria-label="新项目名称"]')`),
      'project home',
    );
    assert.equal(new URL(win.webContents.getURL()).protocol, 'file:');
    assert.equal(
      (await run('window.desktop.getLibrary()')).root,
      join(base, 'projects'),
    );
    await run(`(() => {
      window.referenceUnavailable = [];
      new MutationObserver(() => {
        const notice=document.querySelector('[data-project-unavailable]');
        if(notice) window.referenceUnavailable.push(notice.textContent);
      }).observe(document.body,{subtree:true,childList:true,characterData:true});
    })()`);
    if (mode === 'import') {
      assert.equal(
        (await run('window.desktop.getLibrary()')).projects.length,
        0,
      );
      await click('新建项目');
      await click('新建镜头');
      project = (await run('window.desktop.getLibrary()')).projects[0];
      const closed = new Promise((resolve) =>
        win.once('closed', () => {
          // Windows immediately starts app shutdown after the final window closes.
          if (scenario === 'native-close')
            complete = !!evidence && pickerCalls === 1 && errors.length === 0;
          resolve();
        }),
      );
      await run(`(() => {
        window.referenceCancelledAt=null;
        window.desktop.onReferenceImportProgress(progress => {
          if(window.referenceCancelledAt || progress.phase!=='receiving' || progress.fileIndex!==2 || progress.receivedBytes<=0) return;
          if(progress.receivedBytes>=progress.fileBytes) throw new Error('Large input finished before cancellation could be exercised');
          window.referenceCancelledAt=progress;
          if(${JSON.stringify(scenario)}==='button') {
            const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='取消导入' && !b.closest('[inert]'));
            if(!button || button.disabled) throw new Error('Real cancel button unavailable during active input');
            button.click();
          }
          console.log(${JSON.stringify(marker)}+JSON.stringify(progress));
        });
      })()`);
      await click('导入素材');
      if (scenario === 'native-close') {
        await Promise.race([
          closed,
          sleep(30000).then(() => {
            throw new Error(
              'Native close did not complete safe intake cancellation',
            );
          }),
        ]);
        assert.ok(
          evidence,
          'native close requires positive real receive progress',
        );
        assert.equal(pickerCalls, 1);
        assert.deepEqual(errors, []);
        console.log(
          'PASS native window close during positive-byte receive drains intake and completes the production save handshake',
        );
        complete = true;
        app.quit();
        return;
      }
      await waitFor(
        () =>
          run(
            `document.querySelector('section[aria-label$="素材子画布"]').textContent.includes('已取消导入。已添加 1 个素材，2 个未完成。')`,
          ),
        'cancelled result with one accepted and two unfinished',
      );
      assert.ok(evidence);
      assert.equal(pickerCalls, 1);
    } else {
      evidence = JSON.parse(readFileSync(join(base, 'evidence.json'), 'utf8'));
      project = evidence.project;
      await run(`(() => {
        const button=[...document.querySelectorAll('li button')].find(b=>b.textContent.includes(${JSON.stringify(project.name)}));
        if(!button || button.disabled) throw new Error('Saved project unavailable');
        button.click();
      })()`);
      await click('素材画布');
    }
    const workspace = () =>
      run(
        `window.desktop.getGenerationWorkspace(${JSON.stringify(project.id)})`,
      );
    await waitFor(
      async () =>
        (await workspace()).shots[0]?.nodes.filter(
          (node) => node.type === 'asset',
        ).length === 1,
      'only completed reference is persisted',
    );
    await waitFor(
      () =>
        run(
          `document.querySelector('.generation-reference')?.textContent.includes('完整接收的第一份参考文本。')`,
        ),
      'completed text reference preview',
    );
    if (
      !(await workspace()).shots[0].nodes.some((node) => node.type === 'text')
    ) {
      await click('文本');
      await waitFor(
        () =>
          run(
            `!!document.querySelector('textarea[aria-label="文本卡片内容"]')`,
          ),
        'new text card',
      );
      await run(
        `document.querySelector('textarea[aria-label="文本卡片内容"]').focus({preventScroll:true})`,
      );
      await win.webContents.insertText(text);
    }
    await waitFor(
      async () =>
        (await workspace()).shots[0].nodes.some(
          (node) => node.type === 'text' && node.text === text,
        ),
      'text edit saved',
    );
    await waitFor(
      () =>
        run(
          `document.querySelector('section[aria-label$="素材子画布"] header [role="status"]').textContent==='已保存'`,
        ),
      'saved indicator',
    );
    await click('返回主画布');
    await waitFor(
      () => run(`!document.querySelector('section[aria-label$="素材子画布"]')`),
      'main canvas after material close',
    );
    await run(
      `document.querySelector('button[aria-label="返回项目首页"]').click()`,
    );
    await waitFor(
      () => run(`!!document.querySelector('input[aria-label="新项目名称"]')`),
      'home after safe save',
    );
    assert.equal((await workspace()).shots[0].nodes.length, 2);
    assert.deepEqual(await run('window.referenceUnavailable'), []);
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${scenario}/${mode}: only complete reference survives, text remains editable and returning home safely persists both nodes`,
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
