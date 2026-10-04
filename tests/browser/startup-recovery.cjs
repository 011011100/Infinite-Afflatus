// Actual production main/preload/renderer in separate isolated Electron processes.
// Native recovery dialog choices are supplied programmatically, not OS clicks.
// Run after pnpm build: node tests/browser/startup-recovery.cjs
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');

const root = resolve(__dirname, '../..');
const scenario = process.argv
  .find((argument) => argument.startsWith('--case='))
  ?.slice(7);

function seed(base, kind) {
  const profile = join(base, 'profile');
  const projects = join(base, 'projects');
  const defaultRoot = join(base, 'unused-default-projects');
  mkdirSync(profile);
  mkdirSync(projects);
  const project = {
    id: randomUUID(),
    name: '启动恢复原项目',
    updatedAt: '2026-01-02T03:04:05.000Z',
  };
  project.folder = project.id;
  const projectDirectory = join(projects, project.id);
  mkdirSync(projectDirectory);
  for (const directory of ['assets/videos', 'assets/images', 'cache'])
    mkdirSync(join(projectDirectory, directory), { recursive: true });
  // A fixed version-1 layout also checks that pre-existing profiles remain readable.
  const projectFile = join(projectDirectory, 'project.sqlite');
  const projectDb = new DatabaseSync(projectFile);
  projectDb.exec(`
    PRAGMA application_id = 1229014598;
    PRAGMA user_version = 1;
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE assets (id TEXT PRIMARY KEY, result_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
  `);
  const put = projectDb.prepare('INSERT INTO metadata VALUES (?, ?)');
  put.run('project', JSON.stringify(project));
  put.run('viewport', JSON.stringify({ x: 12, y: 34, zoom: 0.8 }));
  projectDb.close();
  const job = {
    id: randomUUID(),
    projectId: project.id,
    resultKey: 'startup-preserved-result',
    name: '尚待处理的原结果',
    kind: 'video',
    extension: 'mp4',
    status: 'failed',
    size: 0,
    sha256: '',
    error: '原有接收失败记录',
    createdAt: '2026-01-02T03:04:06.000Z',
  };
  const appFile = join(profile, 'app.sqlite');
  const db = new DatabaseSync(appFile);
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE projects (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE saves (id TEXT PRIMARY KEY, result_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO settings VALUES (?, ?)').run('root', projects);
  db.prepare('INSERT INTO projects VALUES (?, ?)').run(
    project.id,
    JSON.stringify(project),
  );
  db.prepare('INSERT INTO saves VALUES (?, ?, ?)').run(
    job.id,
    `${project.id}:${job.resultKey}`,
    JSON.stringify(job),
  );
  db.close();
  mkdirSync(join(profile, 'staging'));
  const stagingFile = join(profile, 'staging', `${job.id}.part`);
  writeFileSync(stagingFile, 'preserve the original uncommitted result');
  if (kind === 'missing-root')
    renameSync(projects, join(base, 'offline-projects'));
  else
    writeFileSync(
      appFile,
      kind === 'empty-store'
        ? ''
        : 'not a SQLite database: preserve these bytes',
    );
  const data = {
    profile,
    projects,
    defaultRoot,
    project,
    projectFile,
    job,
    appFile,
    stagingFile,
  };
  writeFileSync(join(base, 'fixture.json'), JSON.stringify(data));
  return data;
}

async function runCases() {
  const electron = require('electron');
  assert.equal(
    typeof electron,
    'string',
    'Run this harness with Node, not Electron',
  );
  assert.ok(
    existsSync(join(root, 'out/main/index.js')),
    'Build production output first',
  );
  for (const kind of ['missing-root', 'corrupt-store', 'empty-store']) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'afflatus-startup-')));
    const fixture = seed(base, kind);
    try {
      const env = {
        ...process.env,
        AFFLATUS_USER_DATA: fixture.profile,
        AFFLATUS_PROJECTS_DIR: fixture.defaultRoot,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.ELECTRON_RENDERER_URL;
      await new Promise((resolve, reject) => {
        const child = spawn(
          electron,
          [__filename, `--case=${kind}`, `--scratch=${base}`],
          { env, stdio: 'inherit' },
        );
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`Startup recovery process timed out: ${kind}`));
        }, 45000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else
            reject(
              new Error(`Startup recovery ${kind} exited ${signal ?? code}`),
            );
        });
      });
    } finally {
      rmSync(base, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 250,
      });
    }
  }
}

async function runElectronCase() {
  const { app, BrowserWindow, dialog } = require('electron');
  const base = process.argv
    .find((argument) => argument.startsWith('--scratch='))
    ?.slice(10);
  assert.ok(base, 'An isolated fixture directory is required');
  const fixture = JSON.parse(readFileSync(join(base, 'fixture.json'), 'utf8'));
  assert.equal(process.env.AFFLATUS_USER_DATA, fixture.profile);
  assert.equal(process.env.AFFLATUS_PROJECTS_DIR, fixture.defaultRoot);
  app.setPath('userData', fixture.profile);
  const original = readFileSync(fixture.appFile);
  const originalStat = statSync(fixture.appFile);
  const staging = readFileSync(fixture.stagingFile);
  const projectFile =
    scenario === 'missing-root'
      ? join(base, 'offline-projects', fixture.project.id, 'project.sqlite')
      : fixture.projectFile;
  const originalProject = readFileSync(projectFile);
  let windowCreations = 0;
  let complete = false;
  let nativeDialog = null;
  const exit = app.exit.bind(app);
  app.exit = (code = 0) => exit(complete ? code : 1);
  app.on('browser-window-created', () => {
    windowCreations += 1;
  });
  app.on('will-quit', () => {
    if (!complete) process.exitCode = 1;
  });
  dialog.showMessageBox = (...args) =>
    new Promise((respond) => {
      assert.equal(
        nativeDialog,
        null,
        'Unexpected overlapping recovery dialogs',
      );
      nativeDialog = { options: args.at(-1), respond };
    });
  dialog.showErrorBox = (title, message) => {
    console.error('Unexpected non-recoverable startup error:', title, message);
    app.exit(1);
  };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(check, label) {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const result = await check();
      if (result) return result;
      await sleep(25);
    }
    throw new Error(`Timed out: ${label}`);
  }
  function respond(label) {
    const index = nativeDialog.options.buttons.findIndex((button) =>
      button.includes(label),
    );
    assert.notEqual(index, -1, `Missing recovery choice: ${label}`);
    const current = nativeDialog;
    nativeDialog = null;
    current.respond({ response: index, checkboxChecked: false });
  }
  const timeout = setTimeout(() => {
    console.error(`Startup recovery child timed out: ${scenario}`);
    app.exit(1);
  }, 35000);
  app.once('will-quit', () => clearTimeout(timeout));
  try {
    await import(pathToFileURL(join(root, 'out/main/index.js')).href);
    await waitFor(() => nativeDialog, 'native startup recovery dialog');
    assert.equal(windowCreations, 0, 'No main window may open before recovery');
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    assert.equal(
      existsSync(fixture.defaultRoot),
      false,
      'Do not create a fallback project root',
    );
    assert.deepEqual(
      readFileSync(fixture.appFile),
      original,
      'Failed startup must not rewrite the application database',
    );
    assert.equal(statSync(fixture.appFile).mtimeMs, originalStat.mtimeMs);
    assert.deepEqual(readFileSync(projectFile), originalProject);
    assert.deepEqual(readFileSync(fixture.stagingFile), staging);
    if (scenario === 'missing-root') {
      assert.equal(
        existsSync(fixture.projects),
        false,
        'Do not recreate the disconnected root',
      );
      renameSync(join(base, 'offline-projects'), fixture.projects);
      respond('重试');
      const window = await waitFor(
        () => BrowserWindow.getAllWindows()[0],
        'main window after retry',
      );
      window.webContents.setBackgroundThrottling(false);
      const run = (code) => window.webContents.executeJavaScript(code);
      await waitFor(
        () => run(`!!document.querySelector('input[aria-label="新项目名称"]')`),
        'production project home',
      );
      const state = await run('window.desktop.getLibrary()');
      assert.equal(state.root, fixture.projects);
      assert.deepEqual(state.projects, [fixture.project]);
      assert.deepEqual(state.jobs, [fixture.job]);
      const snapshot = await run(
        `window.desktop.openProject(${JSON.stringify(fixture.project.id)})`,
      );
      assert.deepEqual(snapshot.project, fixture.project);
      assert.deepEqual(snapshot.viewport, { x: 12, y: 34, zoom: 0.8 });
      assert.deepEqual(readFileSync(fixture.projectFile), originalProject);
      assert.deepEqual(readFileSync(fixture.stagingFile), staging);
      assert.equal(existsSync(fixture.defaultRoot), false);
      assert.equal(windowCreations, 1);
      assert.equal(nativeDialog, null);
      console.log(
        'PASS production startup preserves the disconnected library, then native-dialog retry restores the original project and save queue through real IPC',
      );
      complete = true;
      app.quit();
    } else {
      console.log(
        `PASS production ${scenario} startup preserves original database/project/staging bytes, opens no main window and creates no fallback library`,
      );
      complete = true;
      respond('退出');
    }
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    exit(1);
  }
}

(scenario ? runElectronCase() : runCases()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
