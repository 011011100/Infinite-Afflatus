// Real production main/preload/renderer; only the native chooser is supplied by the fixture.
// Run after pnpm build: node tests/browser/reference-import.cjs
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = resolve(__dirname, '../..');
const childMode = process.argv.includes('--reference-import-child');
const contents = [
  '第一份有效分镜文本。',
  '',
  '空文件之后的第二份有效分镜文本。',
];
const names = ['有效文本一.txt', 'empty.txt', '有效文本二.txt'];
const editedText = '部分导入失败后仍能继续编辑并保存。';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function runHarness() {
  const electron = require('electron');
  assert.equal(typeof electron, 'string', 'Run this harness with Node');
  assert.ok(
    existsSync(join(root, 'out/main/index.js')),
    'Build production output first',
  );
  // Native canonicalization also expands Windows 8.3 TEMP aliases.
  const base = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'afflatus-reference-import-')),
  );
  const identity = lstatSync(base);
  const owner = randomUUID();
  const marker = join(base, '.fixture-owner');
  const log = join(tmpdir(), `afflatus-reference-import-${owner}.log`);
  writeFileSync(marker, owner, { flag: 'wx' });
  writeFileSync(log, '', { flag: 'wx' });
  let passed = false;
  try {
    for (const folder of ['profile', 'projects', 'inputs'])
      mkdirSync(join(base, folder));
    for (let index = 0; index < names.length; index++)
      writeFileSync(join(base, 'inputs', names[index]), contents[index]);
    const env = {
      ...process.env,
      AFFLATUS_USER_DATA: join(base, 'profile'),
      AFFLATUS_PROJECTS_DIR: join(base, 'projects'),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    await new Promise((resolve, reject) => {
      const child = spawn(
        electron,
        [__filename, '--reference-import-child', `--scratch=${base}`],
        { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
      );
      for (const [stream, target] of [
        [child.stdout, process.stdout],
        [child.stderr, process.stderr],
      ])
        stream.on('data', (data) => {
          appendFileSync(log, data);
          target.write(data);
        });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, 60000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0 && !timedOut) resolve();
        else
          reject(
            new Error(
              `Reference import exited ${signal ?? code}${timedOut ? ' after timeout' : ''}`,
            ),
          );
      });
    });
    for (let index = 0; index < names.length; index++)
      assert.deepEqual(
        readFileSync(join(base, 'inputs', names[index])),
        Buffer.from(contents[index]),
        `Source bytes changed: ${names[index]}`,
      );
    passed = true;
  } finally {
    // The child has exited, so Windows no longer holds SQLite/profile handles.
    const current = lstatSync(base);
    assert.ok(
      !current.isSymbolicLink() &&
        current.dev === identity.dev &&
        current.ino === identity.ino &&
        readFileSync(marker, 'utf8') === owner,
      'Refusing to remove a replaced fixture directory',
    );
    rmSync(base, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 250,
    });
    if (passed) rmSync(log);
    else console.error(`Reference import failure log retained: ${log}`);
  }
}

async function runElectron() {
  const { app, BrowserWindow, dialog } = require('electron');
  const base = process.argv
    .find((argument) => argument.startsWith('--scratch='))
    ?.slice(10);
  assert.ok(base, 'An isolated fixture directory is required');
  assert.equal(realpathSync.native(base), base);
  assert.equal(process.env.AFFLATUS_USER_DATA, join(base, 'profile'));
  assert.equal(process.env.AFFLATUS_PROJECTS_DIR, join(base, 'projects'));
  assert.ok(existsSync(join(base, '.fixture-owner')));
  const sources = names.map((name) => join(base, 'inputs', name));
  const errors = [];
  let chooserCalls = 0;
  let complete = false;
  const exit = app.exit.bind(app);
  app.exit = (code = 0) => exit(complete && code === 0 ? 0 : 1);
  dialog.showOpenDialog = async (_window, options) => {
    assert.equal(options.title, '添加参考素材');
    assert.deepEqual(options.properties, ['openFile', 'multiSelections']);
    chooserCalls += 1;
    return { canceled: false, filePaths: sources };
  };
  dialog.showErrorBox = (title, content) => {
    errors.push(`${title}: ${content}`);
    console.error(title, content);
  };
  dialog.showMessageBox = async (_window, options) => {
    const message = options ?? _window;
    errors.push(`Unexpected native dialog: ${message.message}`);
    console.error('Unexpected native dialog:', message);
    return {
      response: message.cancelId ?? message.buttons.length - 1,
      checkboxChecked: false,
    };
  };
  let painting = false;
  app.on('browser-window-created', (_event, win) => {
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', (details) => {
      if (details.level === 'error') {
        errors.push(details.message);
        console.error('Renderer:', details.message);
      }
    });
    // Keep production page transitions advancing on CI desktops without focus.
    const timer = setInterval(async () => {
      if (painting || win.isDestroyed()) return;
      painting = true;
      try {
        await win.webContents.capturePage();
      } catch {
        // A normal native quit can race the final capture.
      } finally {
        painting = false;
      }
    }, 100);
    win.once('closed', () => clearInterval(timer));
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(check, label) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      assert.deepEqual(errors, [], label);
      if (await check()) return;
      await sleep(40);
    }
    throw new Error(`Timed out: ${label}`);
  }
  try {
    await import(pathToFileURL(join(root, 'out/main/index.js')).href);
    await waitFor(() => BrowserWindow.getAllWindows().length === 1, 'window');
    const win = BrowserWindow.getAllWindows()[0];
    const wc = win.webContents;
    const run = (code) => wc.executeJavaScript(code);
    const click = async (text) => {
      const button = `[...document.querySelectorAll('button')].find(
        b => b.textContent.trim() === ${JSON.stringify(text)} && !b.closest('[inert]')
      )`;
      await waitFor(
        () =>
          run(`(() => { const b = ${button}; return !!b && !b.disabled; })()`),
        `enabled button: ${text}`,
      );
      await run(`(${button}).click()`);
    };
    await waitFor(
      () => run(`!!document.querySelector('input[aria-label="新项目名称"]')`),
      'project home',
    );
    assert.equal(new URL(wc.getURL()).protocol, 'file:');
    const initial = await run('window.desktop.getLibrary()');
    assert.equal(initial.root, join(base, 'projects'));
    assert.deepEqual(initial.projects, []);
    await run(`(() => {
      window.referenceImportUnavailable = [];
      const inspect = () => {
        const notice = document.querySelector('[data-project-unavailable]');
        const status = [...document.querySelectorAll('[role="status"]')].find(
          element => element.textContent.includes('项目不可用')
        );
        if (notice || status) window.referenceImportUnavailable.push((notice || status).textContent);
      };
      new MutationObserver(inspect).observe(document.body, {subtree:true, childList:true, characterData:true});
      inspect();
    })()`);
    await click('新建项目');
    await waitFor(
      () =>
        run(`!!document.querySelector('button[aria-label="返回项目首页"]')`),
      'project canvas',
    );
    const project = await run(
      'window.desktop.getLibrary().then(s => s.projects[0])',
    );
    const workspace = () =>
      run(
        `window.desktop.getGenerationWorkspace(${JSON.stringify(project.id)})`,
      );
    await click('新建镜头');
    await waitFor(
      () =>
        run(`!!document.querySelector('section[aria-label$="素材子画布"]')`),
      'material canvas',
    );
    await click('导入素材');
    await waitFor(
      () =>
        run(`([...document.querySelectorAll('[role="alert"]')].some(
        alert => alert.textContent.includes('empty.txt') && alert.textContent.includes('生成结果为空')
      ))`),
      'explicit empty-file error',
    );
    assert.equal(chooserCalls, 1);
    assert.equal(
      await run(
        `document.querySelector('section[aria-label$="素材子画布"]').textContent.includes('已添加 2 个素材；1 个未添加。')`,
      ),
      true,
    );
    const previewsReady = () =>
      run(`(() => {
      const cards = [...document.querySelectorAll('.generation-reference')];
      return cards.length === 2 && ${JSON.stringify([contents[0], contents[2]])}.every(
        text => cards.some(card => card.textContent.includes(text))
      );
    })()`);
    await waitFor(previewsReady, 'both successful reference previews');
    await waitFor(async () => {
      const saved = await workspace();
      return saved.shots.length === 1 && saved.shots[0].nodes.length === 2;
    }, 'successful references autosaved');
    const imported = await workspace();
    const snapshot = await run(
      `window.desktop.openProject(${JSON.stringify(project.id)})`,
    );
    assert.deepEqual(
      snapshot.assets.map((asset) => asset.name).sort(),
      [names[0], names[2]].sort(),
    );
    assert.equal(imported.shots[0].groups.length, 0);
    assert.deepEqual(
      imported.shots[0].nodes
        .map((node) => ({ type: node.type, id: node.assetId }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      snapshot.assets
        .map((asset) => ({ type: 'asset', id: asset.id }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
    for (const asset of snapshot.assets)
      assert.equal(
        asset.sha256,
        digest(Buffer.from(contents[names.indexOf(asset.name)])),
      );
    assert.equal(
      await run(
        `document.querySelectorAll('.react-flow__node-material').length`,
      ),
      2,
    );
    assert.deepEqual(await run('window.referenceImportUnavailable'), []);
    console.log(
      'PASS mixed native reference import preserves both valid files and reports the empty file without adding a failed node',
    );

    await click('文本');
    await waitFor(
      () =>
        run(`!!document.querySelector('textarea[aria-label="文本卡片内容"]')`),
      'new editable text card',
    );
    assert.equal(
      await run(
        `document.querySelector('textarea[aria-label="文本卡片内容"]').disabled`,
      ),
      false,
    );
    await run(
      `document.querySelector('textarea[aria-label="文本卡片内容"]').focus()`,
    );
    await wc.insertText(editedText);
    await waitFor(async () => {
      const saved = await workspace();
      return (
        saved.shots[0].nodes.length === 3 &&
        saved.shots[0].nodes.some(
          (node) => node.type === 'text' && node.text === editedText,
        )
      );
    }, 'subsequent text autosaved');
    await waitFor(
      () =>
        run(
          `document.querySelector('section[aria-label$="素材子画布"] header [role="status"]').textContent === '已保存'`,
        ),
      'saved status after partial import failure',
    );
    const saved = await workspace();
    const screenshot = join(
      tmpdir(),
      `afflatus-reference-import-${randomUUID()}.png`,
    );
    writeFileSync(screenshot, (await wc.capturePage()).toPNG(), { flag: 'wx' });
    console.log(`SCREENSHOT partial-import result: ${screenshot}`);
    await click('返回主画布');
    await waitFor(
      () => run(`!document.querySelector('section[aria-label$="素材子画布"]')`),
      'returned to main canvas',
    );
    await run(
      `document.querySelector('button[aria-label="返回项目首页"]').click()`,
    );
    await waitFor(
      () => run(`!!document.querySelector('input[aria-label="新项目名称"]')`),
      'returned to project home',
    );
    await run(`(() => {
      const button = [...document.querySelectorAll('li button')].find(b => b.textContent.includes(${JSON.stringify(project.name)}));
      if (!button || button.disabled) throw new Error('Project reopening button unavailable');
      button.click();
    })()`);
    await waitFor(
      () => run(`!!document.querySelector('.react-flow__node-shot button')`),
      'reopened shot card',
    );
    await click('素材画布');
    await waitFor(
      () =>
        run(
          `document.querySelector('textarea[aria-label="文本卡片内容"]')?.value === ${JSON.stringify(editedText)}`,
        ),
      'reopened saved text',
    );
    await waitFor(previewsReady, 'reopened reference previews');
    const reopened = await workspace();
    assert.deepEqual(reopened.shots[0].nodes, saved.shots[0].nodes);
    assert.equal(
      await run(
        `document.querySelectorAll('.react-flow__node-material').length`,
      ),
      3,
    );
    assert.deepEqual(await run('window.referenceImportUnavailable'), []);
    assert.deepEqual(errors, []);
    for (let index = 0; index < sources.length; index++)
      assert.deepEqual(
        readFileSync(sources[index]),
        Buffer.from(contents[index]),
      );
    console.log(
      'PASS subsequent text saves, leaving/reopening restores all three nodes, original bytes stay unchanged and the project never becomes unavailable',
    );
    complete = true;
    app.quit();
  } catch (error) {
    console.error(error);
    exit(1);
  }
}

(childMode ? runElectron() : runHarness()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
