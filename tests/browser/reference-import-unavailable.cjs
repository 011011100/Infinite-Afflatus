// Production import continues while its project database is offline; no mocked receiver or save queue.
// Run after pnpm build: node tests/browser/reference-import-unavailable.cjs
const assert = require('node:assert/strict');
const {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  writeSync,
} = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  hash,
  withFixture,
  runElectron,
} = require('./reference-import-harness.cjs');

const root = resolve(__dirname, '../..');
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7);
const size = 512 * 1024 * 1024;
const names = ['first.txt', 'complete-large.wav', 'last.txt'];
const faultMarker = 'REFERENCE_PROJECT_OFFLINE:';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createAudio(file) {
  // Valid mono 16-bit PCM WAV with sparse, silent sample data and a complete RIFF header.
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(size - 8, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(96000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(size - 44, 40);
  const fd = openSync(file, 'wx');
  try {
    ftruncateSync(fd, size);
    writeSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
}

async function harness() {
  const electron = require('electron');
  assert.equal(typeof electron, 'string', 'Run this harness with Node');
  assert.ok(
    existsSync(join(root, 'out/main/index.js')),
    'Build production output first',
  );
  await withFixture('afflatus-reference-unavailable-', async (base, log) => {
    for (const name of ['profile', 'projects', 'inputs'])
      mkdirSync(join(base, name));
    writeFileSync(
      join(base, 'inputs', names[0]),
      '项目失联前完整接收的第一份文本。',
    );
    createAudio(join(base, 'inputs', names[1]));
    writeFileSync(
      join(base, 'inputs', names[2]),
      '项目失联后仍完整接收的第三份文本。',
    );
    const sources = names.map((name) => join(base, 'inputs', name));
    const before = await Promise.all(sources.map(hash));
    await runElectron(electron, __filename, base, ['--mode=import'], log);
    await runElectron(electron, __filename, base, ['--mode=reopen'], log);
    assert.deepEqual(
      await Promise.all(sources.map(hash)),
      before,
      'all original files, including the entire completed WAV, stay byte-identical',
    );
    console.log(
      'PASS completed import references survive project loss, explicit recovery and a fresh process; all original SHA-256 values remain unchanged',
    );
  });
}

async function electronCase() {
  const { app, BrowserWindow, dialog } = require('electron');
  const base = process.argv
    .find((arg) => arg.startsWith('--scratch='))
    ?.slice(10);
  assert.ok(base && ['import', 'reopen'].includes(mode));
  assert.equal(realpathSync.native(base), base);
  assert.equal(process.env.AFFLATUS_USER_DATA, join(base, 'profile'));
  assert.equal(process.env.AFFLATUS_PROJECTS_DIR, join(base, 'projects'));
  assert.ok(existsSync(join(base, '.fixture-owner')));
  const exit = app.exit.bind(app);
  let complete = false;
  app.exit = (code = 0) => exit(complete && code === 0 ? 0 : 1);
  let project;
  let database;
  let moved = false;
  let pickerCalls = 0;
  const backup = join(base, 'offline-project.sqlite');
  const evidenceFile = join(base, 'evidence.json');
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
  dialog.showErrorBox = (title, message) => {
    errors.push(`${title}: ${message}`);
    console.error(title, message);
  };
  dialog.showMessageBox = async (_window, options) => {
    const value = options ?? _window;
    errors.push(`Unexpected dialog: ${value.message}`);
    return {
      response: value.cancelId ?? value.buttons.length - 1,
      checkboxChecked: false,
    };
  };
  app.on('browser-window-created', (_event, win) => {
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on('console-message', (details) => {
      if (details.level === 'error') {
        errors.push(details.message);
        console.error('Renderer:', details.message);
      }
      if (details.message.startsWith(faultMarker)) {
        try {
          const progress = JSON.parse(
            details.message.slice(faultMarker.length),
          );
          assert.ok(
            database &&
              !moved &&
              progress.fileIndex === 2 &&
              progress.phase === 'receiving' &&
              progress.receivedBytes > 0 &&
              progress.receivedBytes < size,
          );
          renameSync(database, backup);
          moved = true;
          void win.webContents
            .executeJavaScript('window.dispatchEvent(new Event("focus"))')
            .catch((error) => {
              errors.push(String(error));
            });
          console.log(
            `Injected missing project database after ${progress.receivedBytes} actual received bytes`,
          );
        } catch (error) {
          console.error(error);
          exit(1);
        }
      }
    });
    let painting = false;
    const timer = setInterval(async () => {
      if (painting || win.isDestroyed()) return;
      painting = true;
      try {
        await win.webContents.capturePage();
      } catch {
        /* Native quit may race capture. */
      } finally {
        painting = false;
      }
    }, 100);
    win.once('closed', () => clearInterval(timer));
  });
  async function waitFor(check, label, timeout = 45000) {
    const deadline = Date.now() + timeout;
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
    const win = BrowserWindow.getAllWindows()[0];
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
    if (mode === 'import') {
      await click('新建项目');
      await click('新建镜头');
      project = (await run('window.desktop.getLibrary()')).projects[0];
      database = join(base, 'projects', project.id, 'project.sqlite');
    } else {
      project = JSON.parse(readFileSync(evidenceFile, 'utf8')).project;
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
      async () => (await workspace()).shots.length === 1,
      'initial shot has a confirmed baseline',
    );
    const shotId =
      mode === 'import'
        ? (await workspace()).shots[0].id
        : JSON.parse(readFileSync(evidenceFile, 'utf8')).shotId;
    let ids;
    if (mode === 'import') {
      await run(`(() => {
        window.referenceProgress=null;
        window.referenceFaultRequested=false;
        window.referenceUnavailableAt=null;
        new MutationObserver(() => {
          if(!window.referenceUnavailableAt && document.querySelector('[data-project-unavailable]'))
            window.referenceUnavailableAt=window.referenceProgress;
        }).observe(document.body,{subtree:true,childList:true,characterData:true});
        window.desktop.onReferenceImportProgress(progress => {
          window.referenceProgress=progress;
          if(!window.referenceFaultRequested && progress.fileIndex===2 && progress.phase==='receiving' && progress.receivedBytes>0) {
            if(progress.receivedBytes>=progress.fileBytes) throw new Error('Intake completed before the offline case could be exercised');
            window.referenceFaultRequested=true;
            console.log(${JSON.stringify(faultMarker)}+JSON.stringify(progress));
          }
        });
      })()`);
      await click('导入素材');
      await waitFor(
        () => run('!!window.referenceUnavailableAt'),
        'project becomes unavailable during real intake',
      );
      const unavailableAt = await run('window.referenceUnavailableAt');
      assert.equal(unavailableAt.fileIndex, 2);
      assert.equal(
        unavailableAt.phase,
        'receiving',
        'must freeze editing before finalizing, not after import already ended',
      );
      assert.ok(
        unavailableAt.receivedBytes > 0 && unavailableAt.receivedBytes < size,
      );
      assert.equal(moved, true);
      const originalDatabaseHash = await hash(backup);
      await waitFor(
        () =>
          run(
            `window.referenceProgress?.phase==='completed' && document.querySelectorAll('section[aria-label$="素材子画布"] .react-flow__node-material').length===3`,
          ),
        'all completed references retained in the original blocked shot',
      );
      const jobs = (await run('window.desktop.getLibrary()')).jobs.filter(
        (job) => job.projectId === project.id,
      );
      assert.equal(jobs.length, 3);
      assert.ok(jobs.every((job) => job.sha256 && job.size > 0));
      ids = jobs.map((job) => job.id).sort();
      await waitFor(async () => {
        const { drafts } = await run(
          `window.desktop.listWorkspaceDrafts(${JSON.stringify(project.id)})`,
        );
        return drafts.some(
          (draft) =>
            draft.workspace.shots[0]?.id === shotId &&
            JSON.stringify(
              draft.workspace.shots[0]?.nodes
                .map((node) => node.assetId)
                .sort(),
            ) === JSON.stringify(ids),
        );
      }, 'independent recovery draft retains every accepted ID while the project is blocked');
      const attempted = await run(`(() => {
        const section=document.querySelector('section[aria-label$="素材子画布"]');
        [...section.querySelectorAll('button')].find(b=>b.textContent.trim()==='返回主画布').click();
        return section.inert;
      })()`);
      assert.equal(attempted, true, 'real leave starts its save check');
      await waitFor(
        () =>
          run(
            `(() => { const section=document.querySelector('section[aria-label$="素材子画布"]'); return !!section && !section.inert; })()`,
          ),
        'failed leave retains the original material page',
      );
      assert.equal(
        await run(`!!document.querySelector('[data-project-unavailable]')`),
        true,
      );
      assert.equal(
        await run(
          `document.querySelectorAll('section[aria-label$="素材子画布"] .react-flow__node-material').length`,
        ),
        3,
      );
      assert.equal(
        existsSync(database),
        false,
        'no empty replacement database was created',
      );
      assert.equal(
        await hash(backup),
        originalDatabaseHash,
        'offline database has not been modified',
      );
      renameSync(backup, database);
      await click('重试读取项目');
      await waitFor(
        () => run(`!document.querySelector('[data-project-unavailable]')`),
        'explicit retry verifies restored original database',
      );
      await waitFor(
        async () =>
          JSON.stringify(
            (await workspace()).shots[0].nodes
              .map((node) => node.assetId)
              .sort(),
          ) === JSON.stringify(ids),
        'retained IDs save exactly once after recovery',
      );
      writeFileSync(evidenceFile, JSON.stringify({ project, shotId, ids }), {
        flag: 'wx',
      });
      console.log(
        'PASS real intake completes while blocked, every ID reaches the recovery draft, leaving is refused, and explicit retry preserves the original shot',
      );
      await click('返回主画布');
      await waitFor(
        () =>
          run(`!document.querySelector('section[aria-label$="素材子画布"]')`),
        'material page closes after successful recovery',
      );
      // The existing visible queue is the user's explicit retry for copies that failed while offline.
      await run(
        `document.querySelectorAll('aside[aria-label="保存任务"] button').forEach(button => { if(!button.disabled) button.click(); })`,
      );
      await waitFor(
        async () =>
          (await run('window.desktop.getLibrary()')).jobs
            .filter((job) => job.projectId === project.id)
            .every((job) => job.status === 'saved'),
        'existing save queue retries all complete staged results',
      );
      await click('素材画布');
    } else {
      ids = JSON.parse(readFileSync(evidenceFile, 'utf8')).ids;
      assert.equal(pickerCalls, 0);
    }
    await waitFor(
      () =>
        run(
          `document.querySelectorAll('.generation-reference').length===3 && document.querySelector('audio')?.readyState>=1`,
        ),
      'all references, including valid WAV metadata, display after recovery',
    );
    const final = await workspace();
    assert.equal(final.shots.length, 1);
    assert.equal(
      final.shots[0].id,
      shotId,
      'the original shot, not a replacement, keeps the references',
    );
    assert.deepEqual(
      final.shots[0].nodes.map((node) => node.assetId).sort(),
      ids,
    );
    assert.equal(
      new Set(final.shots[0].nodes.map((node) => node.assetId)).size,
      3,
    );
    const snapshot = await run(
      `window.desktop.openProject(${JSON.stringify(project.id)})`,
    );
    assert.deepEqual(snapshot.assets.map((asset) => asset.id).sort(), ids);
    assert.equal(
      await run(`!!document.querySelector('[data-project-unavailable]')`),
      false,
    );
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${mode}: original shot and all three unique reference IDs are saved, source previews load, no project-unavailable notice remains`,
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
