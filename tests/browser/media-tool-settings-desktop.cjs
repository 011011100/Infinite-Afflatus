// Production main/preload/renderer; only the native picker is supplied.
// Version-only programs prove configuration persistence, not media encoding.
// Run after pnpm build: node tests/browser/media-tool-settings-desktop.cjs
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const { join, resolve } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');
const { createVersionTools } = require('./media-tool-fixtures.cjs');
const {
  hash,
  withFixture,
  runElectron,
} = require('./reference-import-harness.cjs');
const root = resolve(__dirname, '../..');
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7);
const settingsKey = 'mediaToolSettings';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readSettings(base) {
  const db = new DatabaseSync(join(base, 'profile', 'app.sqlite'), {
    readOnly: true,
  });
  try {
    assert.equal(
      db.prepare("SELECT value FROM settings WHERE key='root'").get().value,
      join(base, 'projects'),
    );
    return JSON.parse(
      db.prepare('SELECT value FROM settings WHERE key=?').get(settingsKey)
        .value,
    );
  } finally {
    db.close();
  }
}

async function harness() {
  const electron = require('electron');
  assert.equal(typeof electron, 'string', 'Run this harness with Node');
  assert.ok(
    existsSync(join(root, 'out/main/index.js')),
    'Build production output first',
  );
  await withFixture('afflatus-media-settings-', async (base, log) => {
    mkdirSync(join(base, 'profile'));
    mkdirSync(join(base, 'projects'));
    const tools = createVersionTools(base);
    writeFileSync(join(base, 'tools.json'), JSON.stringify(tools), {
      flag: 'wx',
    });
    const before = await Promise.all(Object.values(tools).map(hash));
    const environment = { FFMPEG_PATH: undefined, FFPROBE_PATH: undefined };
    for (const phase of ['configure', 'reopen']) {
      await runElectron(
        electron,
        __filename,
        base,
        [`--mode=${phase}`],
        log,
        environment,
      );
      assert.deepEqual(readSettings(base), {
        version: 1,
        ffmpeg: phase === 'configure' ? tools.ffmpeg : null,
        ffprobe: tools.ffprobe,
      });
    }
    // Only the disposable profile is changed, after its application process has exited.
    assert.ok(existsSync(join(base, '.fixture-owner')));
    const db = new DatabaseSync(join(base, 'profile', 'app.sqlite'));
    try {
      assert.equal(
        db.prepare("SELECT value FROM settings WHERE key='root'").get().value,
        join(base, 'projects'),
      );
      db.prepare('UPDATE settings SET value=? WHERE key=?').run(
        JSON.stringify({
          version: 999,
          ffmpeg: tools.ffmpeg,
          ffprobe: tools.ffprobe,
          future: true,
        }),
        settingsKey,
      );
    } finally {
      db.close();
    }
    await runElectron(
      electron,
      __filename,
      base,
      ['--mode=invalid-recovery'],
      log,
      environment,
    );
    assert.deepEqual(readSettings(base), {
      version: 1,
      ffmpeg: null,
      ffprobe: null,
    });
    assert.deepEqual(
      await Promise.all(Object.values(tools).map(hash)),
      before,
      'source executable bytes stay unchanged',
    );
    console.log(
      'PASS three production processes preserve saved paths, repair only explicitly reset settings, and leave both version-only source executables byte-identical',
    );
  });
}

async function electronCase() {
  const { app, BrowserWindow, dialog } = require('electron');
  const base = process.argv
    .find((arg) => arg.startsWith('--scratch='))
    ?.slice(10);
  assert.ok(base && ['configure', 'reopen', 'invalid-recovery'].includes(mode));
  assert.equal(realpathSync.native(base), base);
  assert.equal(process.env.AFFLATUS_USER_DATA, join(base, 'profile'));
  assert.equal(process.env.AFFLATUS_PROJECTS_DIR, join(base, 'projects'));
  assert.equal(process.env.FFMPEG_PATH, undefined);
  assert.equal(process.env.FFPROBE_PATH, undefined);
  assert.ok(existsSync(join(base, '.fixture-owner')));
  const tools = JSON.parse(readFileSync(join(base, 'tools.json'), 'utf8'));
  const exit = app.exit.bind(app);
  let complete = false;
  app.exit = (code = 0) => exit(complete && code === 0 ? 0 : 1);
  const errors = [];
  const starts = [];
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function (...parameters) {
    const [command, args, options] = parameters;
    if (args?.length === 1 && args[0] === '-version') {
      assert.equal(options.shell, false);
      starts.push({ command, args });
    }
    return originalSpawn.apply(this, parameters);
  };
  syncBuiltinESMExports();
  const selections = [];
  const picked = [];
  dialog.showOpenDialog = async (_window, options) => {
    const choice = selections.shift();
    assert.ok(choice, 'Unexpected native file picker');
    assert.equal(options.title, `选择 ${choice.name} 可执行文件`);
    picked.push(choice);
    return {
      canceled: choice.file === null,
      filePaths: choice.file ? [choice.file] : [],
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
  dialog.showErrorBox = (title, message) => errors.push(`${title}: ${message}`);
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
        /* Native close can end capture. */
      } finally {
        painting = false;
      }
    }, 100);
    win.once('closed', () => clearInterval(timer));
  });
  async function waitFor(check, label) {
    const end = Date.now() + 20000;
    while (Date.now() < end) {
      assert.deepEqual(errors, [], label);
      if (await check()) return;
      await sleep(30);
    }
    throw new Error(`Timed out: ${label}`);
  }
  let win;
  try {
    await import(pathToFileURL(join(root, 'out/main/index.js')).href);
    await waitFor(
      () => BrowserWindow.getAllWindows().length === 1,
      'main window',
    );
    win = BrowserWindow.getAllWindows()[0];
    const run = (code) => win.webContents.executeJavaScript(code);
    const settings = () => run('window.desktop.getMediaToolSettings()');
    const body = () => run('document.body.innerText');
    const query = (label) =>
      `[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent.trim()) === ${JSON.stringify(label)} && !b.closest('[inert]') && b.getClientRects().length)`;
    const click = async (label) => {
      await waitFor(
        () =>
          run(`(() => {const b=${query(label)};return !!b&&!b.disabled})()`),
        `enabled ${label}`,
      );
      await run(`(${query(label)}).click()`);
    };
    const row = (name) =>
      run(`document.querySelector('section[aria-label="${name}"]').innerText`);
    const ready = () =>
      waitFor(
        () =>
          run(
            `!${query('选择 FFprobe 程序')}?.disabled && !!${query('选择 FFprobe 程序')}`,
          ),
        'settings action settled',
      );
    const choose = async (name, file) => {
      const count = picked.length;
      selections.push({ name, file });
      await click(`选择 ${name} 程序`);
      await waitFor(() => picked.length === count + 1, 'native picker used');
      await ready();
    };
    await waitFor(
      () => run('!!document.querySelector("input[aria-label=新项目名称]")'),
      'project home',
    );
    assert.equal(new URL(win.webContents.getURL()).protocol, 'file:');
    const library = await run('window.desktop.getLibrary()');
    assert.equal(library.root, join(base, 'projects'));
    if (mode === 'configure') {
      await click('新建项目');
      await waitFor(
        async () =>
          (await run('window.desktop.getLibrary()')).projects.length === 1,
        'fixture project created',
      );
    } else {
      assert.equal(library.projects.length, 1);
      const project = library.projects[0];
      await run(
        `(() => {const b=[...document.querySelectorAll('li button')].find(b=>b.textContent.includes(${JSON.stringify(project.name)}));if(!b||b.disabled)throw new Error('Saved project missing');b.click()})()`,
      );
    }
    await waitFor(
      () => run('!!document.querySelector("button[aria-label=返回项目首页]")'),
      'project opens even with invalid media preferences',
    );
    await click('设置');
    await click('视频处理');
    await waitFor(
      () => run('!document.body.innerText.includes("正在读取组件设置…")'),
      'read-only settings loaded',
    );
    assert.equal(
      starts.length,
      0,
      'opening a project and settings must not run -version',
    );
    if (mode === 'configure') {
      assert.deepEqual((await settings()).paths, {
        ffmpeg: null,
        ffprobe: null,
      });
      await choose('FFmpeg', null);
      assert.equal(starts.length, 0, 'cancelled picker must not spawn a tool');
      assert.deepEqual((await settings()).paths, {
        ffmpeg: null,
        ffprobe: null,
      });
      await choose('FFmpeg', tools.ffmpeg);
      assert.equal(starts.length, 1);
      assert.equal(starts[0].command, tools.ffmpeg);
      assert.match(await row('FFmpeg'), /fixture-1.0/);
      assert.match(await body(), /已保存，对新任务生效/);
      await choose('FFprobe', tools.ffprobe);
      assert.equal(starts.length, 2);
      assert.deepEqual((await settings()).paths, tools);
      assert.match(await row('FFprobe'), /fixture-1.0/);
      await choose('FFmpeg', tools.ffprobe);
      assert.equal(
        starts.length,
        3,
        'wrong tool was actually executed and its banner rejected',
      );
      assert.deepEqual((await settings()).paths, tools);
      assert.match(await row('FFmpeg'), /fixture-1.0/);
      assert.ok(
        await run(
          '!!document.querySelector("section[aria-label=视频处理组件] [role=alert]")',
        ),
        'failed validation is visible',
      );
      console.log(
        'PASS configure: settings read and cancellation spawn nothing; two real version-only programs validate and persist; wrong-tool validation leaves both saved paths unchanged',
      );
    } else if (mode === 'reopen') {
      assert.deepEqual((await settings()).paths, tools);
      assert.doesNotMatch(await row('FFmpeg'), /fixture-1.0/);
      await click('检查组件');
      await waitFor(
        () => run('document.body.innerText.includes("上次检查：")'),
        'manual version check',
      );
      assert.equal(starts.length, 2);
      assert.deepEqual(
        starts.map(({ command }) => command).sort(),
        Object.values(tools).sort(),
      );
      assert.match(await row('FFmpeg'), /fixture-1.0/);
      assert.match(await row('FFprobe'), /fixture-1.0/);
      await click('恢复 FFmpeg 自动查找');
      await waitFor(
        async () => (await settings()).paths.ffmpeg === null,
        'single reset persisted',
      );
      await ready();
      assert.deepEqual((await settings()).paths, {
        ffmpeg: null,
        ffprobe: tools.ffprobe,
      });
      assert.equal(starts.length, 3, 'single reset diagnoses only that tool');
      assert.match(await row('FFprobe'), /fixture-1.0/);
      console.log(
        'PASS reopen: fresh AppStore retains both paths, explicit check starts exactly both saved programs, and single reset preserves FFprobe',
      );
    } else {
      assert.equal((await settings()).paths, null);
      assert.ok((await settings()).error);
      assert.equal(
        readSettings(base).version,
        999,
        'invalid original value survives startup and read',
      );
      assert.equal(await run(`${query('选择 FFmpeg 程序')}.disabled`), true);
      assert.equal(await run(`${query('检查组件')}.disabled`), true);
      await click('清除两项路径并恢复自动查找');
      await waitFor(
        async () => (await settings()).paths !== null,
        'explicit repair persisted',
      );
      await ready();
      assert.deepEqual((await settings()).paths, {
        ffmpeg: null,
        ffprobe: null,
      });
      assert.equal((await settings()).error, null);
      assert.equal(
        starts.length,
        2,
        'repair diagnoses both automatically resolved tools without assuming they are installed',
      );
      console.log(
        'PASS invalid recovery: an unknown settings version leaves projects usable and its stored value intact until explicit reset-all restores normal automatic discovery',
      );
    }
    assert.equal(selections.length, 0);
    assert.deepEqual(errors, []);
    await click('关闭');
    await waitFor(
      () => run('!document.querySelector("dialog[open]")'),
      'settings closed',
    );
    await click('返回项目首页');
    await waitFor(
      () => run('!!document.querySelector("input[aria-label=新项目名称]")'),
      'project saved before returning home',
    );
    complete = true;
    app.quit();
  } catch (error) {
    console.error(error);
    console.error(JSON.stringify({ mode, starts, errors }));
    if (win && !win.isDestroyed())
      console.error(
        await win.webContents
          .executeJavaScript('document.body.innerText')
          .catch(() => 'renderer unavailable'),
      );
    exit(1);
  }
}
(mode ? electronCase() : harness()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
