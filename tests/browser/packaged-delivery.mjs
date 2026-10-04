// Launch the actual packaged executable against a preseeded, isolated library.
// Run: node --import tsx tests/browser/packaged-delivery.mjs [absolute executable path]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppStore } from '../../src/main/storage/app-store.ts';
import { connect, freePort, waitFor } from './desktop-client.mjs';

async function packagedExecutable() {
  const release = fileURLToPath(new URL('../../release/', import.meta.url));
  const candidates = [];
  for (const entry of await readdir(release, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path =
      process.platform === 'darwin'
        ? join(
            release,
            entry.name,
            'Infinite Afflatus.app',
            'Contents',
            'MacOS',
            'Infinite Afflatus',
          )
        : join(release, entry.name, 'Infinite Afflatus.exe');
    if ((await stat(path).catch(() => null))?.isFile()) candidates.push(path);
  }
  assert.equal(
    candidates.length,
    1,
    'Pass the exact executable path when release contains zero or multiple native builds',
  );
  return candidates[0];
}
const executable = process.argv[2] ?? (await packagedExecutable());
assert.ok(
  executable && isAbsolute(executable),
  'Pass an absolute packaged executable path',
);
const scratch = await realpath(
  await mkdtemp(join(tmpdir(), 'afflatus-packaged-')),
);
const profile = join(scratch, 'profile');
const projects = join(scratch, 'projects');
await mkdir(profile);
await mkdir(projects);
// An existing AppStore makes Library.open use this root instead of the user's Documents.
const store = new AppStore(join(profile, 'app.sqlite'), projects);
store.close();

let current;
async function launch() {
  const port = await freePort();
  const environment = { ...process.env };
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_RENDERER_URL',
    'AFFLATUS_USER_DATA',
    'AFFLATUS_PROJECTS_DIR',
  ])
    delete environment[key];
  const child = spawn(
    executable,
    [
      `--user-data-dir=${profile}`,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
    ],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let diagnostic = '';
  child.stdout.on('data', (chunk) => {
    diagnostic = (diagnostic + chunk).slice(-12000);
  });
  child.stderr.on('data', (chunk) => {
    diagnostic = (diagnostic + chunk).slice(-12000);
  });
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  const exited = new Promise((resolve) => child.once('close', resolve));
  current = { child, exited, client: null };
  const target = await waitFor(async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null)
      throw new Error(`Packaged app exited: ${diagnostic}`);
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(1000),
        })
      ).json();
      return targets.find(
        (entry) =>
          entry.type === 'page' &&
          entry.url.includes('app.asar/out/renderer/index.html'),
      );
    } catch {
      return null;
    }
  }, 'packaged ASAR renderer');
  const client = await connect(target.webSocketDebuggerUrl);
  current.client = client;
  await waitFor(
    () =>
      client.run(`!!document.querySelector('input[aria-label="新项目名称"]')`),
    'packaged project home',
  );
  const library = await client.run('window.desktop.getLibrary()');
  assert.equal(
    library.root,
    projects,
    'packaged process must only access the isolated root',
  );
  assert.equal(await client.run(`typeof window.require`), 'undefined');
  assert.equal(await client.run(`typeof window.process`), 'undefined');
  assert.equal(
    await client.run(
      `document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.includes("script-src 'self';")`,
    ),
    true,
  );
  return client;
}
async function stop() {
  if (!current) return;
  const { child, exited, client } = current;
  client?.close();
  if (child.exitCode === null && child.signalCode === null)
    child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  await exited;
  clearTimeout(timer);
  current = null;
}
const click = (client, label) =>
  client.run(`(() => {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled);
  if (!button) throw new Error('Button unavailable: ' + ${JSON.stringify(label)});
  button.click();
})()`);
try {
  const first = await launch();
  await first.run(
    `document.querySelector('button[aria-label="设置"]').click()`,
  );
  await waitFor(
    () => first.run(`!!document.querySelector('dialog[open]')`),
    'packaged settings',
  );
  await click(first, '视频处理');
  await click(first, '检查组件');
  await waitFor(
    () =>
      first.run(
        `document.querySelector('section[aria-label="视频处理组件"]').textContent.includes('上次检查：')`,
      ),
    'packaged media diagnosis',
  );
  const mediaStatus = await first.run(
    `document.querySelector('section[aria-label="视频处理组件"]').innerText`,
  );
  assert.ok(mediaStatus.includes('FFmpeg') && mediaStatus.includes('FFprobe'));
  assert.equal(mediaStatus.includes('未检查'), false);
  const proof = join(tmpdir(), 'afflatus-packaged-screens');
  await mkdir(proof, { recursive: true });
  const mediaScreenshot = await first.send('Page.captureScreenshot', {
    format: 'png',
  });
  await writeFile(
    join(proof, 'packaged-media-tools.png'),
    Buffer.from(mediaScreenshot.data, 'base64'),
  );
  await first.run(
    `document.querySelector('dialog[open] button[aria-label="关闭"]').click()`,
  );
  await waitFor(
    () => first.run(`!document.querySelector('dialog[open]')`),
    'packaged settings closed',
  );
  console.log(
    'PASS packaged settings invoke the trusted, bounded media-tool diagnosis and render both tool statuses',
  );
  await click(first, '新建项目');
  await waitFor(
    () =>
      first.run(
        `!!document.querySelector('button[aria-label="返回项目首页"]')`,
      ),
    'new packaged project',
  );
  const id = await first.run(
    'window.desktop.getLibrary().then(s => s.projects[0].id)',
  );
  await click(first, '新建镜头');
  await waitFor(
    () =>
      first.run(
        `!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === '文本卡片')`,
      ),
    'packaged material canvas',
  );
  await click(first, '文本卡片');
  await waitFor(
    () =>
      first.run(
        `!!document.querySelector('textarea[aria-label="文本卡片内容"]')`,
      ),
    'packaged text editor',
  );
  await first.run(
    `document.querySelector('textarea[aria-label="文本卡片内容"]').focus()`,
  );
  await first.send('Input.insertText', { text: '正式打包路径中的保存回归' });
  await waitFor(
    () =>
      first.run(
        `window.desktop.getGenerationWorkspace(${JSON.stringify(id)}).then(s => s.shots[0]?.nodes[0]?.text === '正式打包路径中的保存回归')`,
      ),
    'packaged text saved',
  );
  await click(first, '返回主画布');
  await waitFor(
    () =>
      first.run(
        `!document.querySelector('textarea[aria-label="文本卡片内容"]')`,
      ),
    'material canvas closed',
  );
  await first.run(
    `document.querySelector('button[aria-label="返回项目首页"]').click()`,
  );
  await waitFor(
    () =>
      first.run(`!!document.querySelector('input[aria-label="新项目名称"]')`),
    'all drafts flushed before restart',
  );
  assert.deepEqual(first.errors, []);
  console.log(
    'PASS actual packaged ASAR loads its preload and renderer, keeps renderer isolation and saves a text shot through native IPC',
  );
  await stop();
  const second = await launch();
  const reopened = await second.run(
    `window.desktop.getGenerationWorkspace(${JSON.stringify(id)})`,
  );
  assert.equal(reopened.shots[0].nodes[0].text, '正式打包路径中的保存回归');
  assert.equal(
    await second.run(
      'window.desktop.getLibrary().then(s => s.projects.length)',
    ),
    1,
  );
  const screenshot = await second.send('Page.captureScreenshot', {
    format: 'png',
  });
  await writeFile(
    join(proof, 'packaged-reopened.png'),
    Buffer.from(screenshot.data, 'base64'),
  );
  assert.deepEqual(second.errors, []);
  console.log(
    'PASS restarting the packaged executable reopens the isolated saved project; the user library was never used',
  );
  await stop();
} finally {
  await stop();
  await rm(scratch, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 250,
  });
}
