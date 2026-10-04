// Actual process termination and recovery against an isolated library, using the production bundle.
// Run after pnpm build: node --import tsx tests/browser/draft-recovery.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Library } from '../../src/main/storage/library.ts';
import {
  emptyWorkspace,
  newShot,
} from '../../src/shared/generation/workspace.ts';
import { connect, freePort, sleep, waitFor } from './desktop-client.mjs';

const require = createRequire(import.meta.url);
const executable = require('electron');
const main = fileURLToPath(new URL('../../out/main/index.js', import.meta.url));
const scratch = await realpath(
  await mkdtemp(join(tmpdir(), 'afflatus-crash-draft-')),
);
const profile = join(scratch, 'profile');
const projects = join(scratch, 'projects');
const draftText = '项目盘离线期间的镜头文字，异常退出后仍应可恢复。';
const initialText = '已经确认保存的镜头文本';
const projectName = '异常退出恢复回归';
let current;
let phase = 'prepare fixture';
const proof = join(tmpdir(), 'afflatus-draft-recovery-screens');

async function launch() {
  const port = await freePort();
  const environment = {
    ...process.env,
    AFFLATUS_USER_DATA: profile,
    AFFLATUS_PROJECTS_DIR: projects,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_RENDERER_URL;
  const child = spawn(
    executable,
    [
      main,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
    ],
    {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let diagnostic = '';
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  for (const output of [child.stdout, child.stderr])
    output.on('data', (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-12000);
    });
  current = {
    child,
    exited: new Promise((resolve) => child.once('close', resolve)),
    client: null,
  };
  const target = await waitFor(async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null)
      throw new Error(`Application exited: ${diagnostic}`);
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(1000),
        })
      ).json();
      return targets.find(
        (entry) =>
          entry.type === 'page' &&
          entry.url.includes('/out/renderer/index.html'),
      );
    } catch {
      return null;
    }
  }, 'production renderer');
  const client = await connect(target.webSocketDebuggerUrl);
  current.client = client;
  await waitFor(
    () =>
      client.run(`!!document.querySelector('input[aria-label="新项目名称"]')`),
    'project home',
  );
  assert.equal(
    (await client.run('window.desktop.getLibrary()')).root,
    projects,
  );
  return client;
}

async function terminate() {
  if (!current) return;
  current.client?.close();
  if (current.child.exitCode === null && current.child.signalCode === null)
    current.child.kill('SIGKILL');
  await current.exited;
  current = null;
}
const click = async (client, text) => {
  await waitFor(
    () =>
      client.run(
        `!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`,
      ),
    `enabled ${text} action`,
  );
  return client.run(`(() => {
  const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled);
  if (!button) throw new Error('Button unavailable: ' + ${JSON.stringify(text)});
  button.click();
})()`);
};
async function openProject(client) {
  await client.run(`(() => {
    const label = [...document.querySelectorAll('button span')].find(s => s.textContent.trim() === ${JSON.stringify(projectName)});
    const button = label?.closest('button');
    if (!button || button.disabled) throw new Error('Project is not available');
    button.click();
  })()`);
  await waitFor(
    () =>
      client.run(
        `!!document.querySelector('button[aria-label="返回项目首页"]')`,
      ),
    'project canvas',
  );
}
async function draftPersisted() {
  const folder = join(profile, 'workspace-drafts');
  const entries = await readdir(folder, { withFileTypes: true }).catch(
    (error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      if (
        JSON.stringify(
          JSON.parse(await readFile(join(folder, entry.name), 'utf8')),
        ).includes(draftText)
      )
        return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return false;
}
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

async function moveDatabaseOffline(database, heldDatabase) {
  // This process injects the fault while Electron is alive. Windows can reject
  // rename during a short native SQLite read even after the editor is visible.
  const deadline = Date.now() + 5000;
  let busyRetries = 0;
  for (;;) {
    try {
      await rename(database, heldDatabase);
      console.log(
        `Injected unavailable database after ${busyRetries} Windows EBUSY retries`,
      );
      return;
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        error.code !== 'EBUSY' ||
        Date.now() >= deadline
      )
        throw error;
      busyRetries++;
      await sleep(40);
    }
  }
}

try {
  const library = await Library.open(profile, projects);
  const { project } = await library.projects.create(projectName);
  const shot = newShot(randomUUID(), '恢复镜头', { x: 100, y: 100 });
  shot.nodes.push({
    id: randomUUID(),
    type: 'text',
    text: initialText,
    position: { x: 80, y: 100 },
  });
  const baseline = await library.generation.saveWorkspace(project.id, {
    ...emptyWorkspace(),
    shots: [shot],
  });
  await library.close();
  const database = join(projects, project.folder, 'project.sqlite');
  const heldDatabase = join(scratch, 'original-project.sqlite');
  const originalBytes = await readFile(database);
  phase = 'protect text while the project is unavailable';
  const first = await launch();
  await first.run(`(() => {
    window.draftFixtureHealthComplete = false;
    window.draftFixtureStopHealth = window.desktop.onProjectHealthProgress(state => {
      if (state?.projectId === ${JSON.stringify(project.id)} && state.progress === 1)
        window.draftFixtureHealthComplete = true;
    });
  })()`);
  await openProject(first);
  await click(first, '素材画布');
  await waitFor(
    () =>
      first.run(
        `!!document.querySelector('textarea[aria-label="文本卡片内容"]')`,
      ),
    'text card',
  );
  await waitFor(
    () => first.run('window.draftFixtureHealthComplete === true'),
    'initial project health database check completed',
  );
  await first.run('window.draftFixtureStopHealth()');
  await moveDatabaseOffline(database, heldDatabase);
  // Do not continue the crash scenario unless its missing-database fault exists.
  await assert.rejects(readFile(database), { code: 'ENOENT' });
  assert.deepEqual(await readFile(heldDatabase), originalBytes);
  await first.run(
    `(() => { const input = document.querySelector('textarea[aria-label="文本卡片内容"]'); input.focus(); input.select(); })()`,
  );
  await first.send('Input.insertText', { text: draftText });
  await waitFor(
    draftPersisted,
    'independent durable draft while project database is unavailable',
  );
  assert.deepEqual(first.errors, []);
  await terminate();
  assert.deepEqual(await readFile(heldDatabase), originalBytes);
  console.log(
    'PASS actual production renderer journals edited text independently while the project is unavailable; SIGKILL bypasses normal save and close',
  );

  await rename(heldDatabase, database);
  phase = 'reject a conflicting project after restart';
  const conflict = new DatabaseSync(database);
  try {
    const value = structuredClone(baseline);
    value.shots[0].nodes[0].text = '磁盘上另一份同版本修改';
    conflict
      .prepare(
        "UPDATE metadata SET value = ? WHERE key = 'generation-workspace'",
      )
      .run(JSON.stringify(value));
  } finally {
    conflict.close();
  }
  const conflictHash = await hash(database);
  const second = await launch();
  await openProject(second);
  await waitFor(
    () => second.run(`!!document.querySelector('[aria-label="镜头恢复草稿"]')`),
    'recovery conflict notice',
  );
  await waitFor(
    () =>
      second.run(
        `document.querySelector('[aria-label="镜头恢复草稿"]').textContent.includes('不同') || document.querySelector('[aria-label="镜头恢复草稿"]').textContent.includes('冲突')`,
      ),
    'conflict diagnosis',
  );
  assert.equal(
    await second.run(
      `!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === '恢复镜头草稿' && !b.disabled)`,
    ),
    false,
  );
  assert.equal(await hash(database), conflictHash);
  assert.equal(await draftPersisted(), true);
  assert.deepEqual(second.errors, []);
  await terminate();
  console.log(
    'PASS restarting against a same-ID, same-revision conflicting workspace leaves both project and recovery draft intact',
  );

  await writeFile(database, originalBytes);
  phase = 'recover the original project and display its text';
  const third = await launch();
  await openProject(third);
  await waitFor(
    () =>
      third.run(
        `!![...document.querySelectorAll('button')].find(b => b.textContent.trim() === '恢复镜头草稿' && !b.disabled)`,
      ),
    'explicit recovery action',
  );
  assert.equal(
    await third.run(
      `window.desktop.getGenerationWorkspace(${JSON.stringify(project.id)}).then(s => s.shots[0].nodes[0].text)`,
    ),
    initialText,
  );
  await click(third, '恢复镜头草稿');
  await waitFor(
    () =>
      third.run(
        `window.desktop.getGenerationWorkspace(${JSON.stringify(project.id)}).then(s => s.shots[0].nodes[0].text === ${JSON.stringify(draftText)})`,
      ),
    'recovered workspace persisted',
  );
  await click(third, '素材画布');
  await waitFor(
    () =>
      third.run(
        `document.querySelector('textarea[aria-label="文本卡片内容"]')?.value === ${JSON.stringify(draftText)}`,
      ),
    'recovered text visible',
  );
  await mkdir(proof, { recursive: true });
  const screenshot = await third.send('Page.captureScreenshot', {
    format: 'png',
  });
  await writeFile(
    join(proof, 'recovered-text.png'),
    Buffer.from(screenshot.data, 'base64'),
  );
  assert.deepEqual(third.errors, []);
  console.log(
    'PASS restoring the original database permits explicit recovery, writes through native IPC and displays the recovered text',
  );
} catch (error) {
  console.error(`Failed phase: ${phase}`);
  if (current?.client) {
    try {
      console.error(
        await current.client.run('document.body.innerText.slice(0, 8000)'),
      );
      console.error('Renderer errors:', current.client.errors);
      await mkdir(proof, { recursive: true });
      const screenshot = await current.client.send('Page.captureScreenshot', {
        format: 'png',
      });
      await writeFile(
        join(proof, 'failure.png'),
        Buffer.from(screenshot.data, 'base64'),
      );
    } catch (diagnosticError) {
      console.error('Unable to capture failure state:', diagnosticError);
    }
  }
  throw error;
} finally {
  await terminate();
  await rm(scratch, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 250,
  });
}
