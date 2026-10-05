// Only the fixture-owned reference picker is substituted. Production keyboard,
// IPC, autosave, independent drafts and native close protection run unchanged.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { existsSync, readFileSync, realpathSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, dialog } = require('electron');
const { hash } = require('./reference-import-harness.cjs');
const {
  configure,
  exercise,
} = require('./material-keyboard-persistence-cases.cjs');

const base = process.argv
  .find((arg) => arg.startsWith('--scratch='))
  ?.slice(10);
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7);
assert.ok(
  base &&
    ['configure', 'restart-edit', 'restart-failure', 'final-reopen'].includes(
      mode,
    ),
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
const exit = app.exit.bind(app);
app.exit = (code = 0) => exit(complete && code === 0 ? 0 : 1);
app.on('will-quit', () => {
  if (!complete) exit(1);
});
dialog.showOpenDialog = async (...args) => {
  const options = args.at(-1);
  assert.ok(choice, `Unexpected picker: ${options.title}`);
  assert.equal(options.title, '添加参考素材');
  const paths = choice;
  choice = null;
  return { canceled: false, filePaths: paths };
};
dialog.showSaveDialog = async (...args) => {
  throw new Error(`Unexpected save picker: ${args.at(-1).title}`);
};
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
    await sleep(30);
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
  await run(`void (${button(label)}).click()`);
}
const api = (name, ...args) =>
  run(
    `window.desktop.${name}(${args.map((arg) => JSON.stringify(arg)).join(',')})`,
  );
const frame = () =>
  run(
    'new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(null))))',
  );
async function focus(selector) {
  win.focus();
  win.webContents.focus();
  await waitFor(
    () => run(`!!document.querySelector(${JSON.stringify(selector)})`),
    selector,
  );
  await run(
    `document.querySelector(${JSON.stringify(selector)}).focus({preventScroll:true})`,
  );
  await waitFor(
    () =>
      run(
        `document.hasFocus() && document.activeElement===document.querySelector(${JSON.stringify(selector)})`,
      ),
    `native focus ${selector}`,
  );
}
async function key(keyCode, modifiers = []) {
  const before = await run('window.nativeKeyboardEvents.length');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await waitFor(
    () => run(`window.nativeKeyboardEvents.length >= ${before + 2}`),
    `native ${keyCode} events`,
  );
  const received = await run(`window.nativeKeyboardEvents.slice(${before})`);
  assert.deepEqual(
    received.map((event) => event.type),
    ['keydown', 'keyup'],
  );
  assert.ok(received.every((event) => event.trusted && !event.repeat));
  await frame();
}
async function nativeClick(selector) {
  // Establish the target's keyboard focus before the final scroll/measurement;
  // the trusted click below must then actually hit this same button.
  await focus(selector);
  await run(
    `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'})`,
  );
  await frame();
  const point = await run(`(() => {
    const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();
    const x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2);
    if(e.disabled || !r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight || !e.contains(document.elementFromPoint(x,y)))
      throw Error('Native click target is not unobstructed: '+${JSON.stringify(selector)});
    return {x,y};
  })()`);
  const clickCount = await run(
    `window.nativeClickSelector=${JSON.stringify(selector)};window.nativeClickEvents.length`,
  );
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  win.webContents.sendInputEvent({
    type: 'mouseDown',
    button: 'left',
    clickCount: 1,
    ...point,
  });
  win.webContents.sendInputEvent({
    type: 'mouseUp',
    button: 'left',
    clickCount: 1,
    ...point,
  });
  await waitFor(
    () => run(`window.nativeClickEvents.length > ${clickCount}`),
    'native click dispatched',
  );
  const clicked = await run(`window.nativeClickEvents[${clickCount}]`);
  assert.deepEqual(
    clicked,
    { intended: true, trusted: true },
    `Native click missed ${selector}`,
  );
  await frame();
}

async function main() {
  await import(
    pathToFileURL(resolve(__dirname, '../../out/main/index.js')).href
  );
  await waitFor(
    () => BrowserWindow.getAllWindows().length,
    'production window',
  );
  win = BrowserWindow.getAllWindows()[0];
  win.setContentSize(1400, 950);
  await waitFor(
    () =>
      run(
        'document.readyState === "complete" && !!document.querySelector("input[aria-label=新项目名称]")',
      ),
    'initial production home fully loaded',
  );
  await run(`window.nativeKeyboardEvents=[];
    for(const type of ['keydown','keyup']) window.addEventListener(type,event=>window.nativeKeyboardEvents.push({type:event.type,key:event.key,repeat:event.repeat,trusted:event.isTrusted}),true);
    window.nativeClickEvents=[];window.nativeClickSelector=null;
    window.addEventListener('click',event=>{if(window.nativeClickSelector)window.nativeClickEvents.push({intended:!!document.querySelector(window.nativeClickSelector)?.contains(event.target),trusted:event.isTrusted})},true);`);
  const c = {
    base,
    mode,
    api,
    run,
    click,
    button,
    waitFor,
    sleep,
    hash,
    randomUUID,
    key,
    focus,
    frame,
    nativeClick,
    window: win,
    mod: process.platform === 'darwin' ? 'meta' : 'control',
    seed:
      mode === 'configure'
        ? null
        : JSON.parse(readFileSync(join(base, 'seed.json'), 'utf8')),
    expected:
      mode === 'configure'
        ? null
        : JSON.parse(readFileSync(join(base, 'expected.json'), 'utf8')),
    setChoice(paths) {
      assert.equal(choice, null);
      choice = paths;
    },
    allowNativeClose() {
      win.once('closed', () => {
        complete = errors.length === 0 && choice === null;
      });
    },
  };
  if (mode === 'configure') await configure(c);
  else await exercise(c);
  assert.deepEqual(errors, []);
  assert.equal(choice, null);
  complete = true;
  app.quit();
}
main().catch(async (error) => {
  console.error(error);
  if (win && !win.isDestroyed()) {
    try {
      console.error(await run('document.body.innerText'));
    } catch (diagnosticError) {
      console.error('DOM diagnostic failed:', diagnosticError);
    }
  }
  exit(1);
});
