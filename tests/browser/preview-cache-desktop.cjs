// Production main/preload/renderer and real import, saving, proxy registration and cleanup.
// Only the native import picker and two explicitly selected media-tool subprocesses
// are controlled. The tool copies a public synthetic H.264 clip, not real transcoding.
// Chromium metadata/frame decoding is checked separately; no real FFmpeg, packaging,
// large-media performance or overlapping stream-lifetime acceptance is claimed.
// Run only in the consolidated desktop batch after pnpm build:
//   node tests/browser/preview-cache-desktop.cjs
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { randomUUID } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
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
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const json = JSON.stringify;

function metadata(base, project) {
  const db = new DatabaseSync(
    join(base, 'projects', project.folder, 'project.sqlite'),
    { readOnly: true },
  );
  try {
    const rows = db
      .prepare('SELECT key, value FROM metadata ORDER BY key')
      .all();
    return Object.fromEntries(
      rows.map((row) => [row.key, JSON.parse(row.value)]),
    );
  } finally {
    db.close();
  }
}

async function preserved(base, seed) {
  for (const [file, digest] of seed.protected)
    assert.equal(await hash(file), digest, `Preserved bytes: ${file}`);
  const saved = metadata(base, seed.project);
  assert.deepEqual(
    saved.canvas,
    seed.canvas,
    'Card order, position and trim survive',
  );
  assert.deepEqual(
    saved['generation-workspace'],
    seed.workspace,
    'Shot text survives',
  );
}

async function harness() {
  const electron = require('electron');
  assert.equal(typeof electron, 'string', 'Run this harness with Node');
  for (const file of [
    'out/main/index.js',
    'out/preload/index.cjs',
    'out/renderer/index.html',
  ])
    assert.ok(
      existsSync(join(root, file)),
      `Build production output first: ${file}`,
    );
  const { syntheticTrimVideo } = await import('./synthetic-trim-video.mjs');
  await withFixture('afflatus-preview-cache-', async (base, log) => {
    for (const folder of ['profile', 'projects', 'inputs'])
      mkdirSync(join(base, folder));
    writeFileSync(
      join(base, 'inputs', 'synthetic-blue.mp4'),
      syntheticTrimVideo,
      { flag: 'wx' },
    );
    const environment = {
      FFMPEG_PATH: join(base, 'controlled-ffmpeg'),
      FFPROBE_PATH: join(base, 'controlled-ffprobe'),
      AFFLATUS_CACHE_FIXTURE_NODE: process.execPath,
      AFFLATUS_CACHE_FIXTURE_OWNER: readFileSync(
        join(base, '.fixture-owner'),
        'utf8',
      ),
    };
    for (const phase of ['cleanup', 'reopen']) {
      await runElectron(
        electron,
        __filename,
        base,
        [`--mode=${phase}`],
        log,
        environment,
      );
      const seed = JSON.parse(readFileSync(join(base, 'seed.json'), 'utf8'));
      await preserved(base, seed);
      assert.equal(existsSync(seed.removedFile), false);
      const proxies = metadata(base, seed.project).proxies;
      assert.equal(proxies.length, phase === 'cleanup' ? 1 : 2);
      assert.equal(
        proxies[0].relativePath,
        seed.removedRelativePath,
        'Cleanup keeps manifest history',
      );
      if (phase === 'reopen') {
        const rebuilt = join(
          base,
          'projects',
          seed.project.folder,
          proxies[1].relativePath,
        );
        assert.notEqual(rebuilt, seed.removedFile);
        assert.equal(await hash(rebuilt), seed.sourceHash);
      }
    }
    console.log(
      'PASS preview-cache desktop: real production IPC inspection, cancellation, single-use and reload-stale confirmations, paused editor lease, exact Settings cleanup, fresh-process on-demand rebuild, original/unknown/draft bytes and saved edits preserved. Controlled copy encoder; real FFmpeg and in-flight stream overlap are not tested.',
    );
  });
}

async function electronCase() {
  const { app, BrowserWindow, dialog, ipcMain, net } = require('electron');
  const base = process.argv
    .find((arg) => arg.startsWith('--scratch='))
    ?.slice(10);
  assert.ok(base && ['cleanup', 'reopen'].includes(mode));
  assert.equal(realpathSync.native(base), base);
  assert.equal(process.env.AFFLATUS_USER_DATA, join(base, 'profile'));
  assert.equal(process.env.AFFLATUS_PROJECTS_DIR, join(base, 'projects'));
  assert.equal(
    readFileSync(join(base, '.fixture-owner'), 'utf8'),
    process.env.AFFLATUS_CACHE_FIXTURE_OWNER,
  );
  assert.ok(process.env.AFFLATUS_CACHE_FIXTURE_NODE);
  const starts = [];
  const calls = [];
  const errors = [];
  let complete = false;
  let picked = 0;
  let win;
  const exit = app.exit.bind(app);
  app.exit = (code = 0) => exit(complete && code === 0 ? 0 : 1);
  app.on('will-quit', () => {
    if (!complete) exit(1);
  });

  // Delegate exact fixture commands only. Real production transcodeProxy, save,
  // fingerprint, manifest and cleanup implementations remain unchanged.
  const spawn = childProcess.spawn;
  childProcess.spawn = function (command, args, options) {
    const tool = ['ffmpeg', 'ffprobe'].find(
      (name) => command === join(base, `controlled-${name}`),
    );
    assert.ok(tool, `Unexpected subprocess: ${command}`);
    assert.equal(options.shell, false);
    starts.push({ tool, args });
    return spawn.call(
      this,
      process.env.AFFLATUS_CACHE_FIXTURE_NODE,
      [join(__dirname, 'preview-cache-desktop-tool.cjs'), tool, base, ...args],
      options,
    );
  };
  syncBuiltinESMExports();
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) =>
    handle(channel, async (...args) => {
      const result = await listener(...args);
      if (channel.startsWith('preview-cache:') || channel.startsWith('media:'))
        calls.push({ channel, result });
      return result;
    });
  dialog.showOpenDialog = async (_window, options) => {
    assert.equal(mode, 'cleanup');
    assert.equal(options.title, '导入视频');
    assert.equal(++picked, 1);
    return {
      canceled: false,
      filePaths: [join(base, 'inputs', 'synthetic-blue.mp4')],
    };
  };
  dialog.showMessageBox = async (...args) => {
    const options = args.at(-1);
    errors.push(`Unexpected dialog: ${options.message}`);
    return {
      response: options.cancelId ?? options.buttons.length - 1,
      checkboxChecked: false,
    };
  };
  dialog.showErrorBox = (title, message) => errors.push(`${title}: ${message}`);
  app.on('browser-window-created', (_event, window) => {
    window.webContents.setBackgroundThrottling(false);
    window.webContents.on('render-process-gone', (_event, details) =>
      errors.push(`Renderer exited: ${details.reason}`),
    );
    window.webContents.on('console-message', (details) => {
      if (details.level === 'error') errors.push(details.message);
    });
    let painting = false;
    const timer = setInterval(async () => {
      if (painting || window.isDestroyed()) return;
      painting = true;
      try {
        await window.webContents.capturePage();
      } catch {
        // Native close may end the capture.
      } finally {
        painting = false;
      }
    }, 100);
    window.once('closed', () => clearInterval(timer));
  });
  async function waitFor(check, label) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      assert.deepEqual(errors, [], label);
      const value = await check();
      if (value) return value;
      await sleep(30);
    }
    throw new Error(`Timed out: ${label}`);
  }
  const run = (code) => win.webContents.executeJavaScript(code);
  const api = (name, ...args) =>
    run(`window.desktop.${name}(${args.map(json).join(',')})`);
  const button = (label) =>
    `[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent.trim()) === ${json(label)} && !b.closest('[inert]') && b.getClientRects().length)`;
  const click = async (label) => {
    await waitFor(
      () => run(`!!${button(label)} && !${button(label)}.disabled`),
      `enabled ${label}`,
    );
    await run(`(${button(label)}).click()`);
  };
  const home = () =>
    waitFor(
      () =>
        run(
          '!!window.desktop && !!document.querySelector("input[aria-label=新项目名称]")',
        ),
      'project home',
    );
  const count = (channel) =>
    calls.filter((call) => call.channel === channel).length;
  const last = (channel) =>
    calls.findLast((call) => call.channel === channel)?.result;
  const openProject = async (project) => {
    await run(
      `(() => {const b=[...document.querySelectorAll('li button')].find(b=>b.textContent.includes(${json(project.name)}));if(!b||b.disabled)throw new Error('Saved fixture project missing');b.click()})()`,
    );
    await waitFor(
      () => run('!!document.querySelector("button[aria-label=返回项目首页]")'),
      'project canvas',
    );
  };
  const openSettings = async () => {
    await click('设置');
    await click('保存与存储');
  };
  const closeSettings = async () => {
    await click('关闭');
    await waitFor(
      () => run('!document.querySelector("dialog[open]")'),
      'settings closed',
    );
  };
  const stale = async (token) =>
    assert.rejects(api('executePreviewCacheCleanup', token), /失效|过期/);
  const pausedEditor = async (seed) => {
    const acquired = count('media:acquire-proxy-usage');
    const prepared = count('media:prepare-proxy');
    await click(`播放 ${seed.asset.name}`);
    await waitFor(
      () =>
        count('media:acquire-proxy-usage') > acquired &&
        count('media:prepare-proxy') > prepared,
      'editor session and preparation IPC',
    );
    assert.equal(last('media:prepare-proxy').ready, true);
    await waitFor(
      () =>
        run(`(() => {
      const videos=[...document.querySelectorAll('section[aria-label="视频画面"] video')];
      return videos.length === 4 && videos.some(v => v.readyState >= 2 && v.videoWidth === 96 && v.videoHeight === 54) && videos.every(v => v.paused);
    })()`),
      'real decoded synthetic frame in paused editor',
    );
    await sleep(250);
    const inspection = await api('inspectPreviewCache');
    assert.equal(inspection.eligibleCount, 0);
    assert.ok(
      inspection.items.some(
        (item) => item.kind === 'proxy' && /播放、读取或编辑/.test(item.reason),
      ),
    );
  };
  const closeEditor = async () => {
    const released = count('media:release-proxy-usage');
    await click('返回画布');
    await waitFor(
      () => count('media:release-proxy-usage') > released,
      'editor releases session lease',
    );
    await waitFor(
      async () => (await api('inspectPreviewCache')).eligibleCount === 1,
      'closed editor cache becomes eligible',
    );
  };

  try {
    await import(pathToFileURL(join(root, 'out/main/index.js')).href);
    await waitFor(
      () => BrowserWindow.getAllWindows().length === 1,
      'production main window',
    );
    win = BrowserWindow.getAllWindows()[0];
    await home();
    assert.equal(new URL(win.webContents.getURL()).protocol, 'file:');
    assert.equal((await api('getLibrary')).root, join(base, 'projects'));
    assert.equal(app.getPath('userData'), join(base, 'profile'));
    let seed;
    if (mode === 'cleanup') {
      const { project } = await api('createProject', '预览缓存桌面验收');
      const independent = (await api('createProject', '独立草稿保留')).project;
      await api('importVideos', project.id);
      await waitFor(
        async () =>
          (await api('getLibrary')).jobs.some((job) => job.status === 'saved'),
        'real import durably saved',
      );
      let snapshot = await api('openProject', project.id);
      assert.equal(snapshot.assets.length, 1);
      const asset = snapshot.assets[0];
      const card = snapshot.canvas.cards[0];
      snapshot = await api('patchCanvas', project.id, {
        before: [card],
        after: [{ ...card, trims: { [asset.id]: { start: 1, end: 6 } } }],
      });
      const baseline = await api('getGenerationWorkspace', project.id);
      const workspace = await api('saveGenerationWorkspace', project.id, {
        ...baseline,
        shots: [
          {
            id: randomUUID(),
            name: '清理后保留的镜头',
            position: { x: 500, y: 100 },
            viewport: { x: 0, y: 0, zoom: 1 },
            nodes: [
              {
                id: randomUUID(),
                type: 'text',
                text: '缓存清理不能改写镜头文字。',
                position: { x: 0, y: 0 },
              },
            ],
            groups: [],
          },
        ],
      });
      const independentBaseline = await api(
        'getGenerationWorkspace',
        independent.id,
      );
      await api('protectWorkspaceDraft', independent.id, {
        sessionId: randomUUID(),
        seq: 1,
        baseline: independentBaseline,
        workspace: { ...workspace, revision: independentBaseline.revision },
      });
      assert.equal(
        (await api('listWorkspaceDrafts', independent.id)).drafts.length,
        1,
      );
      assert.equal(
        (await api('prepareProxy', project.id, asset.id)).ready,
        true,
      );
      const projectRoot = join(base, 'projects', project.folder);
      const proxy = metadata(base, project).proxies[0];
      const unknown = join(projectRoot, 'cache', 'user-kept.txt');
      const staged = join(base, 'profile', 'staging', 'unregistered.keep');
      writeFileSync(unknown, 'Unknown user cache file must remain.', {
        flag: 'wx',
      });
      writeFileSync(staged, 'Unregistered staging bytes must remain.', {
        flag: 'wx',
      });
      const drafts = readdirSync(join(base, 'profile', 'workspace-drafts'), {
        recursive: true,
      })
        .filter((file) => file.endsWith('.json'))
        .map((file) => join(base, 'profile', 'workspace-drafts', file));
      assert.equal(
        drafts.length,
        1,
        'A real independent recovery draft was written',
      );
      const protectedFiles = [
        join(base, 'inputs', asset.name),
        join(projectRoot, asset.relativePath),
        unknown,
        staged,
        ...drafts,
        join(base, 'projects', independent.folder, 'project.sqlite'),
      ];
      seed = {
        project,
        asset,
        canvas: snapshot.canvas,
        workspace,
        sourceHash: asset.sha256,
        removedRelativePath: proxy.relativePath,
        removedFile: join(projectRoot, proxy.relativePath),
        protected: await Promise.all(
          protectedFiles.map(async (file) => [file, await hash(file)]),
        ),
      };
      writeFileSync(join(base, 'seed.json'), json(seed), { flag: 'wx' });
      assert.equal(await hash(seed.removedFile), seed.sourceHash);
      await openProject(project);

      const inspection = await api('inspectPreviewCache');
      assert.equal(inspection.eligibleCount, 1);
      assert.equal(inspection.eligibleBytes, asset.size);
      assert.ok(
        inspection.items.some(
          (item) =>
            item.relativePath === 'cache/user-kept.txt' && !item.canCleanup,
        ),
      );
      const cancelled = await api('previewCacheCleanup');
      await api('cancelPreviewCacheOperations');
      await stale(cancelled.token);
      const older = await api('previewCacheCleanup');
      const newer = await api('previewCacheCleanup');
      await stale(older.token);
      const usage = await api('acquireProxyUsage', project.id, [asset.id]);
      const retained = await api('executePreviewCacheCleanup', newer.token);
      assert.equal(retained.removedCount, 0);
      assert.equal(retained.removedBytes, 0);
      assert.match(retained.retained[0].reason, /播放、读取或编辑/);
      await stale(newer.token);
      await api('releaseProxyUsage', usage);
      await pausedEditor(seed);
      await closeEditor();

      await openSettings();
      const previews = count('preview-cache:preview-cleanup');
      await click('检查预览缓存');
      await waitFor(
        () => count('preview-cache:preview-cleanup') > previews,
        'Settings inspection reaches production IPC',
      );
      const dismissed = last('preview-cache:preview-cleanup').token;
      const cancellations = count('preview-cache:cancel');
      await click('暂不清理缓存');
      await waitFor(
        () => count('preview-cache:cancel') > cancellations,
        'Settings cancellation reaches production IPC',
      );
      await stale(dismissed);
      assert.equal(
        await hash(seed.removedFile),
        seed.sourceHash,
        'Inspect/cancel never removes or changes bytes',
      );
      await closeSettings();

      const beforeReload = await api('previewCacheCleanup');
      await new Promise((done) => {
        win.webContents.once('did-finish-load', done);
        win.reload();
      });
      await home();
      await stale(beforeReload.token);
      await openProject(project);
      await openSettings();
      await click('检查预览缓存');
      await waitFor(
        () =>
          run(
            '!!document.querySelector("section[aria-label=预览缓存清理预览]")',
          ),
        'explicit Settings confirmation',
      );
      assert.equal(await hash(seed.removedFile), seed.sourceHash);
      const confirmation = last('preview-cache:preview-cleanup');
      assert.equal(confirmation.files.length, 1);
      assert.equal(confirmation.files[0].relativePath, proxy.relativePath);
      await preserved(base, seed);
      const executions = count('preview-cache:execute-cleanup');
      await click('确认清理 1 个缓存文件');
      await waitFor(
        () => count('preview-cache:execute-cleanup') > executions,
        'Settings cleanup finishes',
      );
      assert.deepEqual(last('preview-cache:execute-cleanup'), {
        removedCount: 1,
        removedBytes: asset.size,
        retained: [],
        cancelled: false,
      });
      await waitFor(
        () =>
          run(
            'document.querySelector("section[aria-label=预览缓存]").innerText.includes("已清理 1 个缓存文件")',
          ),
        'actual cleanup result shown',
      );
      await stale(confirmation.token);
      assert.equal(existsSync(seed.removedFile), false);
      await preserved(base, seed);
      await closeSettings();
      assert.deepEqual(
        starts.map(({ tool }) => tool),
        ['ffprobe', 'ffmpeg', 'ffprobe'],
      );
    } else {
      seed = JSON.parse(readFileSync(join(base, 'seed.json'), 'utf8'));
      await preserved(base, seed);
      assert.equal(existsSync(seed.removedFile), false);
      const before = await api('openProject', seed.project.id);
      assert.deepEqual(before.assets, [seed.asset]);
      assert.deepEqual(before.canvas, seed.canvas);
      assert.equal((await api('inspectPreviewCache')).eligibleCount, 0);
      await openProject(seed.project);
      assert.equal(
        starts.length,
        0,
        'Ordinary startup and canvas do not recreate deleted proxy',
      );
      await pausedEditor(seed);
      const proxies = metadata(base, seed.project).proxies;
      assert.equal(proxies.length, 2);
      assert.notEqual(proxies[1].relativePath, seed.removedRelativePath);
      assert.equal(
        await hash(
          join(base, 'projects', seed.project.folder, proxies[1].relativePath),
        ),
        seed.sourceHash,
      );
      await closeEditor();
      // Electron networking uses the production protocol handler. Renderer fetch
      // intentionally remains blocked by the production connect-src policy.
      const read = await net.fetch(
        `afflatus-media://proxy/${seed.project.id}/${seed.asset.id}`,
        { headers: { Range: 'bytes=0-31' } },
      );
      const response = {
        status: read.status,
        range: read.headers.get('Content-Range'),
        bytes: [...new Uint8Array(await read.arrayBuffer())],
      };
      assert.deepEqual(response, {
        status: 206,
        range: `bytes 0-31/${seed.asset.size}`,
        bytes: [
          ...readFileSync(join(base, 'inputs', seed.asset.name)).subarray(
            0,
            32,
          ),
        ],
      });
      await waitFor(
        async () => (await api('inspectPreviewCache')).eligibleCount === 1,
        'completed range read releases protection',
      );
      await preserved(base, seed);
      assert.deepEqual(
        starts.map(({ tool }) => tool),
        ['ffprobe', 'ffmpeg', 'ffprobe'],
      );
      assert.equal(picked, 0);
    }
    assert.deepEqual(errors, []);
    await click('返回项目首页');
    await home();
    console.log(
      `PASS preview-cache ${mode}: owned production process completed; controlled tool calls=${starts.length}`,
    );
    complete = true;
    app.quit();
  } catch (error) {
    console.error(error);
    console.error(
      json({
        mode,
        starts,
        errors,
        calls: calls.map(({ channel }) => channel),
      }),
    );
    if (win && !win.isDestroyed())
      console.error(
        await run('document.body.innerText').catch(
          () => 'renderer unavailable',
        ),
      );
    exit(1);
  }
}

(mode ? electronCase() : harness()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require('electron').app.exit(1);
  else process.exitCode = 1;
});
