// Real built main/preload/renderer IPC in an isolated library; native file pickers choose synthetic fixtures.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const {
  mkdtempSync,
  existsSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  readFileSync,
  realpathSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog } = require('electron');
if (process.platform !== 'darwin') {
  console.log('SKIP delivery close/reopen smoke: macOS desktop required');
  app.exit(0);
}
let failed = false;
const root = resolve(__dirname, '../..');
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'afflatus-delivery-')));
const exit = app.exit.bind(app);
app.exit = (code) => {
  rmSync(scratch, { recursive: true, force: true });
  exit(failed ? 1 : code);
};
process.env.AFFLATUS_USER_DATA = join(scratch, 'app');
process.env.AFFLATUS_PROJECTS_DIR = join(scratch, 'projects');
delete process.env.ELECTRON_RENDERER_URL;
const source = join(scratch, '蓝色视频.mp4');
const video = join(scratch, '成片.mp4');
const backup = join(scratch, '项目备份.afflatus');
const ffmpeg = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=blue:s=320x180:r=30:d=1',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  source,
]);
assert.equal(
  ffmpeg.status,
  0,
  ffmpeg.stderr?.toString() || 'FFmpeg unavailable',
);
dialog.showOpenDialog = async (_window, options) => ({
  canceled: false,
  filePaths: [options.title === '导入项目包' ? backup : source],
});
dialog.showSaveDialog = async (_window, options) => ({
  canceled: false,
  filePath: options.title === '导出项目包' ? backup : video,
});
dialog.showErrorBox = (title, content) => {
  console.error(title, content);
  process.exitCode = 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await check()) return;
    await sleep(40);
  }
  throw new Error(`Timed out: ${label}`);
}
async function main() {
  await import(pathToFileURL(join(root, 'out/main/index.js')).href);
  await waitFor(() => BrowserWindow.getAllWindows().length > 0, 'main window');
  const win = BrowserWindow.getAllWindows()[0];
  const wc = win.webContents;
  wc.setBackgroundThrottling(false);
  const errors = [];
  wc.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const run = (script) => wc.executeJavaScript(script);
  const click = (text) =>
    run(
      `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) throw new Error('Button unavailable: '+${JSON.stringify(text)}); b.click(); })()`,
    );
  await waitFor(
    () => run(`!!document.querySelector('input[aria-label="新项目名称"]')`),
    'project home',
  );
  await click('新建项目');
  await waitFor(
    () => run(`!!document.querySelector('button[aria-label="返回项目首页"]')`),
    'project canvas',
  );
  const projectId = await run(
    `window.desktop.getLibrary().then(s => s.projects[0].id)`,
  );
  await click('新建镜头');
  await waitFor(
    () =>
      run(
        `!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === '文本卡片')`,
      ),
    'material canvas',
  );
  await click('文本卡片');
  await waitFor(
    () =>
      run(`!!document.querySelector('textarea[aria-label="文本卡片内容"]')`),
    'text material',
  );
  // Send real input and immediately close before the 350ms autosave debounce.
  await run(
    `document.querySelector('textarea[aria-label="文本卡片内容"]').focus()`,
  );
  wc.insertText('窗口关闭前最后一次修改');
  await sleep(25);
  win.close();
  await waitFor(() => win.isDestroyed(), 'save-before-close handshake');
  assert.equal(
    process.platform,
    'darwin',
    'this close/reopen smoke currently targets macOS',
  );
  app.emit('activate');
  await waitFor(
    () => BrowserWindow.getAllWindows().length > 0,
    'reopened window',
  );
  const reopened = BrowserWindow.getAllWindows()[0];
  let capturing = false;
  const paintTimer = setInterval(async () => {
    if (capturing || reopened.isDestroyed()) return;
    capturing = true;
    try {
      await reopened.webContents.capturePage();
    } catch {
      /* Window may close between frames. */
    } finally {
      capturing = false;
    }
  }, 100);
  reopened.once('closed', () => clearInterval(paintTimer));
  let missingMediaExpected = false;
  reopened.webContents.setBackgroundThrottling(false);
  reopened.webContents.on('console-message', (details) => {
    if (
      details.level === 'error' &&
      !(
        missingMediaExpected &&
        details.message.startsWith('Failed to load resource:')
      )
    )
      errors.push(details.message);
  });
  const next = (script) => reopened.webContents.executeJavaScript(script);
  await waitFor(
    () => next(`!!document.querySelector('input[aria-label="新项目名称"]')`),
    'reopened home',
  );
  const workspace = await next(
    `window.desktop.getGenerationWorkspace(${JSON.stringify(projectId)})`,
  );
  assert.equal(workspace.shots[0].nodes[0].text, '窗口关闭前最后一次修改');
  console.log(
    'PASS native window close flushes debounced text through real IPC before destruction',
  );
  await next(`window.desktop.importVideos(${JSON.stringify(projectId)})`);
  await waitFor(
    () =>
      next(
        `window.desktop.openProject(${JSON.stringify(projectId)}).then(s => s.assets.length === 1)`,
      ),
    'imported video saved',
  );
  const snapshot = await next(
    `window.desktop.openProject(${JSON.stringify(projectId)})`,
  );
  const info = await next(
    `window.desktop.inspectProjectPackage(${JSON.stringify(projectId)})`,
  );
  assert.equal(info.assetCount, 1);
  const packagePath = await next(
    `window.desktop.exportProjectPackage(${JSON.stringify(projectId)}, crypto.randomUUID())`,
  );
  assert.equal(packagePath, backup);
  assert.ok(existsSync(backup));
  const imported = await next(
    'window.desktop.importProjectPackage(crypto.randomUUID())',
  );
  assert.notEqual(imported.project.id, projectId);
  const importedWorkspace = await next(
    `window.desktop.getGenerationWorkspace(${JSON.stringify(imported.project.id)})`,
  );
  assert.equal(
    importedWorkspace.shots[0].nodes[0].text,
    '窗口关闭前最后一次修改',
  );
  assert.equal(imported.assets[0].sha256, snapshot.assets[0].sha256);
  console.log(
    'PASS real preload project package export/import preserves text and media in a new project',
  );
  await next(
    `window.desktop.startExport(${JSON.stringify(projectId)}, ${JSON.stringify(snapshot.canvas.cards[0].id)}, {resolution:'720p',frameRate:30})`,
  );
  await waitFor(
    () =>
      next(
        `window.desktop.listExports().then(j => j[0] && ['completed','failed'].includes(j[0].status))`,
      ),
    'video export',
    60000,
  );
  const jobs = await next('window.desktop.listExports()');
  assert.equal(jobs[0].status, 'completed', jobs[0].error);
  assert.ok(existsSync(video));
  console.log('PASS real FFmpeg export through trusted desktop IPC completes');
  await waitFor(
    () =>
      next(
        `!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === '导出任务')`,
      ),
    'export task notification',
  );
  await next(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '导出任务').click()`,
  );
  await waitFor(
    () => next(`!!document.querySelector('dialog[open]')`),
    'export task modal',
  );
  assert.equal(
    await next(
      `document.querySelector('dialog').textContent.includes('导出完成')`,
    ),
    true,
  );
  if (process.env.AFFLATUS_TEST_SCREENSHOTS) {
    await sleep(350);
    mkdirSync(process.env.AFFLATUS_TEST_SCREENSHOTS, { recursive: true });
    writeFileSync(
      join(process.env.AFFLATUS_TEST_SCREENSHOTS, 'delivery-tasks.png'),
      (await reopened.webContents.capturePage()).toPNG(),
    );
  }
  await next(
    `document.querySelector('dialog button[aria-label="关闭"]').click()`,
  );
  await waitFor(
    () => next(`!document.querySelector('dialog')`),
    'close task modal',
  );
  await next(
    `window.desktop.renameProject(${JSON.stringify(projectId)}, '备份验证项目')`,
  );
  await waitFor(
    () =>
      next(
        `!!Array.from(document.querySelectorAll('li button')).find(b => b.textContent.includes('备份验证项目'))`,
      ),
    'renamed backup project',
  );
  await next(
    `Array.from(document.querySelectorAll('li button')).find(b => b.textContent.includes('备份验证项目')).click()`,
  );
  await waitFor(
    () => next(`!!document.querySelector('button[aria-label="返回项目首页"]')`),
    'open imported project',
  );
  await waitFor(
    () =>
      next(
        `!!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '项目备份' && !b.disabled)`,
      ),
    'project is ready for backup',
  );
  await next(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '项目备份').click()`,
  );
  await waitFor(
    () =>
      next(
        `!!document.querySelector('dialog')?.textContent.includes('1 个素材')`,
      ),
    'backup preview',
  );
  await next(
    `document.querySelector('dialog button[aria-label="关闭"]').click()`,
  );
  await waitFor(
    () => next(`!document.querySelector('dialog')`),
    'close backup preview',
  );
  // Open with a genuinely missing managed file, then repair through the native picker/IPC/UI.
  await next(
    `document.querySelector('button[aria-label="返回项目首页"]').click()`,
  );
  await waitFor(
    () => next(`!!document.querySelector('input[aria-label="新项目名称"]')`),
    'home before missing media',
  );
  const managed = join(
    process.env.AFFLATUS_PROJECTS_DIR,
    imported.project.folder,
    imported.assets[0].relativePath,
  );
  const database = join(
    process.env.AFFLATUS_PROJECTS_DIR,
    imported.project.folder,
    'project.sqlite',
  );
  unlinkSync(managed);
  missingMediaExpected = true;
  await next(
    `window.desktop.renameProject(${JSON.stringify(imported.project.id)}, '恢复验证项目')`,
  );
  await waitFor(
    () =>
      next(
        `!!Array.from(document.querySelectorAll('li button')).find(b => b.textContent.includes('恢复验证项目'))`,
      ),
    'unopened missing-media project',
  );
  const savedDatabase = readFileSync(database);
  await next(
    `Array.from(document.querySelectorAll('li button')).find(b => b.textContent.includes('恢复验证项目')).click()`,
  );
  await waitFor(
    () =>
      next(`!!document.querySelector('button[aria-label="1 个素材需要检查"]')`),
    'automatic missing media check',
  );
  await waitFor(
    () => next(`!!document.querySelector('[title="缩略图读取失败"]')`),
    'missing thumbnail error',
  );
  await next(
    `document.querySelector('button[aria-label="1 个素材需要检查"]').click()`,
  );
  await waitFor(
    () =>
      next(
        `!!document.querySelector('dialog[open].is-open')?.textContent.includes('原文件缺失')`,
      ),
    'health issues modal',
  );
  if (process.env.AFFLATUS_TEST_SCREENSHOTS) {
    await sleep(350);
    await reopened.webContents.capturePage();
    await sleep(100);
    writeFileSync(
      join(process.env.AFFLATUS_TEST_SCREENSHOTS, 'delivery-health.png'),
      (await reopened.webContents.capturePage()).toPNG(),
    );
  }
  await next(
    `Array.from(document.querySelectorAll('dialog button')).find(b => b.textContent.trim() === '找到原文件').click()`,
  );
  await waitFor(
    () =>
      next(
        `!!document.querySelector('dialog')?.textContent.includes('未发现缺失或大小异常的素材')`,
      ),
    'restored media report',
  );
  await waitFor(
    () =>
      next(
        `!document.querySelector('[title="缩略图读取失败"]') && document.querySelector('[data-video-thumbnail] canvas')?.width === 320`,
      ),
    'same-ID restored thumbnail retries',
  );
  assert.deepEqual(readFileSync(managed), readFileSync(source));
  assert.deepEqual(readFileSync(database), savedDatabase);
  missingMediaExpected = false;
  await next(
    `document.querySelector('dialog button[aria-label="关闭"]').click()`,
  );
  await waitFor(
    () => next(`!document.querySelector('dialog')`),
    'close health check',
  );
  console.log(
    'PASS actual missing media auto-detection, exact-byte UI restore and thumbnail refresh preserve project database',
  );
  await next(`document.querySelector('button[aria-label^="播放 "]').click()`);
  await waitFor(
    () =>
      next(
        `!!Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '导出视频' && !b.disabled)`,
      ),
    'sequence editor export button',
  );
  await next(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '导出视频').click()`,
  );
  await waitFor(
    () => next(`!!document.querySelector('dialog[open].is-open select')`),
    'export options',
  );
  assert.equal(
    await next(`document.querySelector('dialog select').value`),
    '1080p',
  );
  if (process.env.AFFLATUS_TEST_SCREENSHOTS) {
    await sleep(350);
    await reopened.webContents.capturePage();
    await sleep(100);
    writeFileSync(
      join(process.env.AFFLATUS_TEST_SCREENSHOTS, 'delivery-export.png'),
      (await reopened.webContents.capturePage()).toPNG(),
    );
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(
    'PASS built renderer task UI and production file loading; no renderer errors',
  );
}
main()
  .catch(async (error) => {
    failed = true;
    console.error(error);
    const current = BrowserWindow.getAllWindows()[0];
    if (current)
      console.error(
        await current.webContents.executeJavaScript('document.body.innerText'),
      );
  })
  .finally(async () => {
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    // A normal app quit drains all independent writers before the scratch directory is removed.
    app.quit();
  });
