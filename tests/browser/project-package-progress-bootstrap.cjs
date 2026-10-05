// The only substitutions are fixture-local native selections and delayed real
// package-file writes. Production IPC, queues, transactions and cleanup run intact.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { existsSync, readFileSync, realpathSync } = require('node:fs');
const fs = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog } = require('electron');
const { hash } = require('./reference-import-harness.cjs');
const { configure, exercise } = require('./project-package-progress-cases.cjs');

const base = process.argv
  .find((arg) => arg.startsWith('--scratch='))
  ?.slice(10);
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7);
assert.ok(
  base &&
    [
      'configure',
      'roundtrip',
      'cancel',
      'leave-home',
      'leave-close',
      'reopen-1',
      'reopen-2',
    ].includes(mode),
);
assert.equal(realpathSync.native(base), base);
assert.ok(existsSync(join(base, '.fixture-owner')));
assert.equal(process.env.AFFLATUS_USER_DATA, join(base, 'profile'));
assert.equal(process.env.AFFLATUS_PROJECTS_DIR, join(base, 'projects'));

const errors = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let complete = false;
let win;
let choice = null;
let picker = null;
let throttle = false;
let delayedBytes = 0;
const exit = app.exit.bind(app);
app.exit = (code = 0) => exit(complete && code === 0 ? 0 : 1);
app.on('will-quit', () => {
  if (!complete) exit(1);
});

const originalOpen = fs.open;
fs.open = async function (file, ...args) {
  const handle = await originalOpen.call(this, file, ...args);
  const path = typeof file === 'string' ? relative(base, file) : '';
  const owned =
    path &&
    path !== '..' &&
    !isAbsolute(path) &&
    !path.startsWith(`..${sep}`) &&
    !path.startsWith(sep) &&
    (path.split(sep).some((part) => part.startsWith('.afflatus-package-')) ||
      (path.startsWith(`external${sep}.`) && path.endsWith('.part')));
  if (owned) {
    for (const name of ['write', 'writeFile']) {
      const original = handle[name].bind(handle);
      handle[name] = async (...values) => {
        const size = Buffer.isBuffer(values[0]) ? values[0].length : 0;
        if (throttle && size >= 16 * 1024) await sleep(25);
        const result = await original(...values);
        if (throttle && size >= 16 * 1024)
          delayedBytes += name === 'write' ? result.bytesWritten : size;
        return result;
      };
    }
  }
  return handle;
};
syncBuiltinESMExports();

async function pick(options, save) {
  assert.ok(choice, `Unexpected chooser: ${options.title}`);
  assert.equal(options.title, choice.title);
  const selected = choice;
  choice = null;
  if (selected.deferred) {
    return new Promise((done) => {
      picker = {
        release: () =>
          done(
            save
              ? { canceled: false, filePath: selected.path }
              : { canceled: false, filePaths: [selected.path] },
          ),
      };
    });
  }
  return save
    ? { canceled: false, filePath: selected.path }
    : { canceled: false, filePaths: selected.paths ?? [selected.path] };
}
dialog.showSaveDialog = (...args) => pick(args.at(-1), true);
dialog.showOpenDialog = (...args) => pick(args.at(-1), false);
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
async function waitFor(check, label) {
  const deadline = Date.now() + 20000;
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
const api = (name, ...args) =>
  run(
    `window.desktop.${name}(${args.map((arg) => JSON.stringify(arg)).join(',')})`,
  );

async function main() {
  await import(
    pathToFileURL(resolve(__dirname, '../../out/main/index.js')).href
  );
  await waitFor(
    () => BrowserWindow.getAllWindows().length,
    'production window',
  );
  win = BrowserWindow.getAllWindows()[0];
  await waitFor(
    () =>
      run(
        `document.readyState === 'complete' && !!document.querySelector('input[aria-label="新项目名称"]')`,
      ),
    'loaded production home',
  );
  const seed =
    mode === 'configure'
      ? null
      : JSON.parse(readFileSync(join(base, 'seed.json'), 'utf8'));
  await run(
    `window.packageEvents=[]; void window.desktop.onProjectPackageProgress(value=>window.packageEvents.push(value));`,
  );
  const context = {
    base,
    mode,
    seed,
    api,
    run,
    click,
    button,
    waitFor,
    sleep,
    hash,
    randomUUID,
    window: win,
    setChoice(value) {
      assert.equal(choice, null);
      choice = value;
    },
    async releasePicker() {
      await waitFor(() => picker, 'native chooser outstanding');
      const pending = picker;
      picker = null;
      pending.release();
    },
    pickerPending: () => !!picker,
    setThrottle(value) {
      throttle = value;
      delayedBytes = 0;
    },
    delayedBytes: () => delayedBytes,
    allowNativeClose() {
      win.once('closed', () => {
        complete = errors.length === 0 && choice === null && picker === null;
      });
    },
  };
  if (mode === 'configure') await configure(context);
  else await exercise(context);
  assert.deepEqual(errors, []);
  assert.equal(choice, null, 'Every planned chooser must have been exercised');
  assert.equal(picker, null, 'No unresolved native picker');
  complete = true;
  app.quit();
}
main().catch((error) => {
  console.error(error);
  exit(1);
});
