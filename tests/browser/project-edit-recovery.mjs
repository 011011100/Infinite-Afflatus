// Real production renderer + native SQLite + SIGKILL, with isolated IPC faults.
// Run after pnpm build: node --import tsx tests/browser/project-edit-recovery.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
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
import { recordAsset } from '../../src/main/projects/project-database.ts';
import { Library } from '../../src/main/storage/library.ts';
import {
  emptyWorkspace,
  newShot,
} from '../../src/shared/generation/workspace.ts';
import { connect, freePort, waitFor } from './desktop-client.mjs';
import { syntheticTrimVideo } from './synthetic-trim-video.mjs';

const executable = createRequire(import.meta.url)('electron');
const main = fileURLToPath(new URL('../../out/main/index.js', import.meta.url));
const bootstrap = fileURLToPath(
  new URL('./project-edit-recovery-bootstrap.cjs', import.meta.url),
);
const scratch = await realpath(
  await mkdtemp(join(tmpdir(), 'afflatus-edit-recovery-')),
);
const identity = await lstat(scratch);
const owner = randomUUID();
await writeFile(join(scratch, '.fixture-owner'), owner, { flag: 'wx' });
const profile = join(scratch, 'profile');
const projects = join(scratch, 'projects');
const proof = join(tmpdir(), `afflatus-project-edit-recovery-${owner}`);
const exportPath = join(scratch, '裁剪恢复.afflatus-edit-draft.json');
const heldDatabase = join(scratch, 'original-project.sqlite');
let current;
let project;
let database;
let sequence = 0;
let phase = 'seed actual project';
let stageLibrary;

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => JSON.stringify(value);
function metadata(key) {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    return db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)
      ?.value;
  } finally {
    db.close();
  }
}
function diskName() {
  return JSON.parse(metadata('project')).name;
}
async function records() {
  const folder = join(profile, 'project-edit-drafts');
  const entries = await readdir(folder).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const result = [];
  for (const entry of entries.filter((name) => name.endsWith('.json'))) {
    try {
      result.push(JSON.parse(await readFile(join(folder, entry), 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return result;
}
async function protectedRecord(predicate) {
  return waitFor(
    async () => (await records()).find(predicate),
    'durable editor record',
  );
}
async function launch(fault, lostReplies = 1) {
  const configFile = join(scratch, `launch-${++sequence}.json`);
  const marker = join(scratch, `fault-${sequence}.json`);
  await writeFile(
    configFile,
    json({
      owner,
      scratch,
      profile,
      main,
      fault,
      lostReplies,
      marker,
      exportPath,
      database,
      heldDatabase,
      projectId: project.id,
    }),
  );
  const port = await freePort();
  const environment = {
    ...process.env,
    AFFLATUS_USER_DATA: profile,
    AFFLATUS_PROJECTS_DIR: projects,
    AFFLATUS_EDIT_RECOVERY_FIXTURE: configFile,
    // Original H.264 media decodes in Chromium. Disable optional proxy generation
    // deterministically so derived cache writes cannot obscure preservation checks.
    FFMPEG_PATH: join(scratch, 'absent-optional-encoder'),
    FFPROBE_PATH: join(scratch, 'absent-optional-probe'),
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_RENDERER_URL;
  const child = spawn(
    executable,
    [
      bootstrap,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
    ],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  for (const output of [child.stdout, child.stderr])
    output.on('data', (chunk) => {
      log = (log + chunk).slice(-18000);
    });
  current = {
    child,
    marker,
    client: null,
    log: () => log,
    exited: new Promise((resolve) => child.once('close', resolve)),
  };
  const target = await waitFor(async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Production main exited: ${log}`);
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${port}/json/list`, {
          signal: AbortSignal.timeout(1000),
        })
      ).json();
      return targets.find(
        (item) =>
          item.type === 'page' && item.url.includes('/out/renderer/index.html'),
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
  const active = current;
  active.client?.close();
  if (active.child.exitCode === null && active.child.signalCode === null)
    active.child.kill('SIGKILL');
  await active.exited;
  if (current === active) current = null;
}
async function click(client, label, scope = 'document') {
  const expression = `([...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${json(label)} && !b.disabled))`;
  await waitFor(() => client.run(`!!${expression}`), `enabled ${label}`);
  await client.run(`${expression}.click()`);
}
async function openProject(client) {
  const name = diskName();
  await client.run(`(() => {
    const label = [...document.querySelectorAll('button span')].find(s => s.textContent.trim() === ${json(name)});
    const button = label?.closest('button');
    if (!button || button.disabled) throw new Error('Project unavailable');
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
async function enterName(client, value) {
  await waitFor(
    () =>
      client.run(
        `!!document.querySelector('input[aria-label="项目名称"]:not([readonly])')`,
      ),
    'editable project name',
  );
  await client.run(
    `(() => { const input = document.querySelector('input[aria-label="项目名称"]'); input.focus(); input.select(); })()`,
  );
  await client.send('Input.insertText', { text: value });
  return protectedRecord(
    (record) => record.kind === 'name' && record.target === value,
  );
}
async function openRename(client) {
  await waitFor(
    () =>
      client.run(
        `!!document.querySelector('button[title="修改项目名称"]:not([disabled])')`,
      ),
    'rename action',
  );
  await client.run(
    `document.querySelector('button[title="修改项目名称"]').click()`,
  );
}
async function screenshot(client, name) {
  await mkdir(proof, { recursive: true });
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(proof, `${name}.png`), Buffer.from(shot.data, 'base64'));
}
async function waitNotice(client) {
  await waitFor(
    () =>
      client.run(`!!document.querySelector('[aria-label="项目编辑恢复草稿"]')`),
    'project edit recovery notice',
  );
}
async function saveName(client, expected) {
  await click(client, '保存', `document.querySelector('dialog[open]')`);
  await waitFor(() => diskName() === expected, 'explicit name commit');
  await waitFor(
    () => client.run(`!document.querySelector('input[aria-label="项目名称"]')`),
    'rename dialog acknowledged',
  );
  await waitFor(
    async () => !(await records()).some((record) => record.kind === 'name'),
    'name record acknowledgement',
  );
}
async function dragTrim(client, assetId) {
  const selector = `[data-timeline-clip="${assetId}"]`;
  await waitFor(
    () =>
      client.run(
        `(() => { const node = document.querySelector(${json(selector)}); const grip = node?.querySelector('button[aria-label="片段起点"]'); return !!grip && !grip.disabled && Number(grip.getAttribute('aria-valuemax')) > 1; })()`,
      ),
    'decoded video and enabled trim gesture',
  );
  const rect = await client.run(
    `(() => { const r = document.querySelector(${json(selector)}).getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`,
  );
  const x = rect.x + 6;
  const y = rect.y + rect.height / 2;
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await waitFor(
    () =>
      client.run(
        `getComputedStyle(document.querySelector(${json(selector)}).querySelector('button[aria-label="片段起点"]')).pointerEvents === 'auto'`,
      ),
    'hovered trim handle',
  );
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  const moved = x + Math.min(90, rect.width / 4);
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: moved,
    y,
    button: 'left',
    buttons: 1,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: moved,
    y,
    button: 'left',
    clickCount: 1,
  });
  return protectedRecord(
    (record) =>
      record.kind === 'trim' && record.target.trims?.[assetId]?.start > 0,
  );
}

try {
  stageLibrary = await Library.open(profile, projects);
  project = (await stageLibrary.projects.create('项目编辑强杀恢复')).project;
  database = await stageLibrary.projects.databasePath(project.id);
  const assets = [];
  for (let i = 0; i < 2; i++) {
    const id = randomUUID();
    const asset = {
      id,
      name: `纯色视频 ${i + 1}.mp4`,
      relativePath: `assets/videos/${id}.mp4`,
      size: syntheticTrimVideo.length,
      sha256: digest(syntheticTrimVideo),
      kind: 'video',
    };
    await writeFile(
      join(projects, project.folder, asset.relativePath),
      syntheticTrimVideo,
    );
    stageLibrary.store.putProject(
      recordAsset(database, `fixture:${i}`, asset, project),
    );
    assets.push(asset);
  }
  let snapshot = await stageLibrary.projects.open(project.id);
  snapshot = await stageLibrary.projects.patchCanvas(project.id, {
    before: snapshot.canvas.cards,
    after: snapshot.canvas.cards.map((card, index) => ({
      ...card,
      position: { x: 100 + index * 350, y: 100 },
    })),
  });
  const shot = newShot(randomUUID(), '不相关镜头', { x: 100, y: 420 });
  shot.nodes.push({
    id: randomUUID(),
    type: 'text',
    text: '此镜头原文、位置与参数必须保留。',
    position: { x: 80, y: 100 },
  });
  await stageLibrary.generation.saveWorkspace(project.id, {
    ...emptyWorkspace(),
    shots: [shot],
  });
  await stageLibrary.close();
  stageLibrary = null;
  const initialCanvas = snapshot.canvas;
  const unchangedWorkspace = metadata('generation-workspace');
  const otherCard = initialCanvas.cards[1];
  const expectedAssets = snapshot.assets;
  const unchanged = async () => {
    assert.equal(metadata('generation-workspace'), unchangedWorkspace);
    assert.deepEqual(
      JSON.parse(metadata('canvas')).cards.find(
        (card) => card.id === otherCard.id,
      ),
      otherCard,
    );
    for (const asset of assets)
      assert.equal(
        digest(
          await readFile(join(projects, project.folder, asset.relativePath)),
        ),
        asset.sha256,
      );
  };

  phase = 'name input protected before SIGKILL';
  let client = await launch();
  await openProject(client);
  await openRename(client);
  const nameDraft = await enterName(client, '  强杀时尚未提交的名称  ');
  assert.equal(diskName(), project.name);
  await screenshot(client, 'name-protected');
  assert.deepEqual(client.errors, []);
  await terminate();
  assert.equal(diskName(), project.name);
  assert.equal((await records())[0].target, nameDraft.target);

  phase = 'explicit continue name then save after restart';
  client = await launch();
  await openProject(client);
  await waitNotice(client);
  await click(client, '继续修改名称');
  await waitFor(
    () =>
      client.run(
        `document.querySelector('input[aria-label="项目名称"]')?.value === ${json(nameDraft.target)}`,
      ),
    'restored raw name input',
  );
  assert.equal(diskName(), project.name);
  const committedName = '重启后明确保存的名称';
  await enterName(client, committedName);
  assert.equal(diskName(), project.name);
  await saveName(client, committedName);
  assert.deepEqual(JSON.parse(metadata('canvas')), initialCanvas);
  await unchanged();
  assert.deepEqual(client.errors, []);
  await terminate();
  console.log(
    'PASS production name typing survives SIGKILL; continuing restores raw input and only explicit Save changes the project name',
  );

  phase = 'completed pointer trim protected before unavailable database write';
  client = await launch('trim-unavailable');
  await openProject(client);
  await waitFor(
    () =>
      client.run(
        `!!document.querySelector('button[aria-label=${json(`播放 ${assets[0].name}`)}]')`,
      ),
    'video play action',
  );
  await client.run(
    `document.querySelector('button[aria-label=${json(`播放 ${assets[0].name}`)}]').click()`,
  );
  const gestureRecord = await dragTrim(client, assets[0].id);
  const fault = await waitFor(async () => {
    try {
      return JSON.parse(await readFile(current.marker, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }, 'real missing-database write rejection');
  assert.equal(fault.fault, 'trim-unavailable');
  assert.match(fault.error, /不存在|ENOENT|no such file|找不到/);
  // prepare() publishes a newer sequence with the exact submitted card before
  // invoking patchCanvas. Capture that durable watermark, not an earlier stage.
  const trimRecord = (await records()).find(
    (record) => record.sessionId === gestureRecord.sessionId,
  );
  assert.ok(trimRecord);
  assert.deepEqual(trimRecord.target, gestureRecord.target);
  assert.deepEqual(trimRecord.lastSubmitted, trimRecord.target);
  await assert.rejects(readFile(database), { code: 'ENOENT' });
  await screenshot(client, 'trim-protected-unavailable');
  assert.deepEqual(client.errors, []);
  await terminate();
  await rename(heldDatabase, database);
  assert.deepEqual(JSON.parse(metadata('canvas')), initialCanvas);
  await unchanged();
  const originalBytes = await readFile(database);
  console.log(
    'PASS actual completed trim pointer gesture is protected before the production SQLite write fails; SIGKILL retains its exact range',
  );

  phase = 'conflicting card refuses restore but allows rescue export';
  const conflicting = structuredClone(initialCanvas);
  conflicting.cards[0].trims = { [assets[0].id]: { start: 0.1, end: 7.8 } };
  const writer = new DatabaseSync(database);
  try {
    writer
      .prepare("UPDATE metadata SET value = ? WHERE key = 'canvas'")
      .run(json(conflicting));
  } finally {
    writer.close();
  }
  client = await launch();
  await openProject(client);
  await waitNotice(client);
  await waitFor(
    () =>
      client.run(
        `document.querySelector('[aria-label="项目编辑恢复草稿"]').textContent.includes('当前内容与原版本不同')`,
      ),
    'conflict notice',
  );
  assert.equal(
    await client.run(
      `([...document.querySelectorAll('[aria-label="项目编辑恢复草稿"] button')].find(b => b.textContent.trim() === '恢复并保存裁剪')).disabled`,
    ),
    true,
  );
  const refused = await client.run(
    `window.desktop.recoverProjectEditDraft(${json(project.id)}, ${json({ sessionId: trimRecord.sessionId, seq: trimRecord.seq })}).then(() => ({ok:true}), error => ({ok:false,error:String(error)}))`,
  );
  assert.equal(
    refused.ok,
    false,
    'native recovery must also reject the conflict',
  );
  await click(client, '导出恢复文件');
  await waitFor(
    () =>
      client.run(
        `document.querySelector('[aria-label="项目编辑恢复草稿"]').textContent.includes('只读编辑恢复文件已保存：')`,
      ),
    'completed read-only rescue export',
  );
  const rescue = JSON.parse(await readFile(exportPath, 'utf8'));
  assert.equal(rescue.format, 'infinite-afflatus-project-edit-rescue');
  assert.equal(rescue.draft.sessionId, trimRecord.sessionId);
  assert.deepEqual(rescue.draft.target, trimRecord.target);
  assert.deepEqual(JSON.parse(metadata('canvas')), conflicting);
  assert.deepEqual(await records(), [trimRecord]);
  await unchanged();
  await screenshot(client, 'trim-conflict-export');
  assert.deepEqual(client.errors, []);
  await terminate();
  await writeFile(database, originalBytes);
  console.log(
    'PASS changed card content blocks both UI and native recovery; rescue export preserves the original draft, unrelated data and source media',
  );

  phase = 'explicit trim recovery writes only the protected card';
  client = await launch('trim-cleanup');
  await openProject(client);
  await waitNotice(client);
  await click(client, '恢复并保存裁剪');
  await waitFor(
    () =>
      json(
        JSON.parse(metadata('canvas')).cards.find(
          (card) => card.id === trimRecord.target.id,
        ),
      ) === json(trimRecord.target),
    'recovered trim committed',
  );
  await waitFor(
    () =>
      client.run(
        `!![...document.querySelectorAll('[aria-label="项目编辑恢复草稿"] button')].find(b => b.textContent.trim() === '确认已保存' && !b.disabled)`,
      ),
    'committed trim remains available for cleanup acknowledgement',
  );
  const cleanupFault = JSON.parse(await readFile(current.marker, 'utf8'));
  assert.equal(cleanupFault.fault, 'trim-cleanup');
  assert.deepEqual(await records(), [trimRecord]);
  await client.run(`window.dispatchEvent(new Event('focus'))`);
  // Exercise the normal post-focus interface too: cleanup must succeed in this
  // same mounted canvas, without restarting or using the unavailable retry path.
  await click(client, '确认已保存');
  await waitFor(
    async () => (await records()).length === 0,
    'same-window cleanup retry',
  );
  assert.equal(
    await client.run(`!!document.querySelector('[data-project-unavailable]')`),
    false,
  );
  assert.equal(
    JSON.parse(metadata('canvas')).revision,
    initialCanvas.revision + 1,
  );
  assert.deepEqual(
    (await client.run(`window.desktop.openProject(${json(project.id)})`))
      .assets,
    expectedAssets,
  );
  await unchanged();
  assert.deepEqual(client.errors, []);
  await terminate();
  console.log(
    'PASS committed trim survives cleanup unlink failure, focus and same-window cleanup retry; only one card/revision changes and unrelated work/source media stay intact',
  );

  phase = 'name A and B each commit with a lost IPC reply, then C is protected';
  client = await launch('name-lost-reply', 2);
  await openProject(client);
  await openRename(client);
  const nameA = '已提交但回执丢失的名称 A';
  const nameB = '随后提交但也丢失回执的名称 B';
  const nameC = '两次丢失回执后保护的名称 C';
  await enterName(client, nameA);
  await click(client, '保存', `document.querySelector('dialog[open]')`);
  await waitFor(() => diskName() === nameA, 'A really committed');
  await waitFor(async () => {
    try {
      return JSON.parse(await readFile(current.marker, 'utf8')).name === nameA;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }, 'injected lost reply after commit');
  const b = await enterName(client, nameB);
  assert.equal(b.lastSubmitted, nameA);
  assert.equal(diskName(), nameA);
  await click(client, '保存', `document.querySelector('dialog[open]')`);
  await waitFor(
    () => diskName() === nameB,
    'B really committed after checking A',
  );
  await waitFor(async () => {
    const marker = JSON.parse(await readFile(current.marker, 'utf8'));
    return marker.count === 2 && marker.name === nameB;
  }, 'second actual committed response lost');
  const c = await enterName(client, nameC);
  assert.equal(c.baseline, nameA);
  assert.equal(c.lastSubmitted, nameB);
  assert.equal(diskName(), nameB);
  assert.deepEqual(client.errors, []);
  await terminate();
  client = await launch();
  await openProject(client);
  await waitNotice(client);
  await click(client, '继续修改名称');
  await waitFor(
    () =>
      client.run(
        `document.querySelector('input[aria-label="项目名称"]')?.value === ${json(nameC)}`,
      ),
    'C restored after two lost committed replies',
  );
  assert.equal(diskName(), nameB);
  await saveName(client, nameC);
  await unchanged();
  const finalCanvas = JSON.parse(metadata('canvas'));
  assert.equal(finalCanvas.revision, initialCanvas.revision + 1);
  assert.deepEqual(
    finalCanvas.cards.find((card) => card.id === trimRecord.target.id),
    trimRecord.target,
  );
  assert.deepEqual(client.errors, []);
  await terminate();
  console.log(
    'PASS two real A/B commits each lose their IPC response; protected C survives a new process and saves without overwriting unrelated edits',
  );
  console.log(`Project edit recovery screenshots: ${proof}`);
} catch (error) {
  console.error(`Project edit recovery failed during: ${phase}`);
  console.error(current?.log() ?? '');
  if (current?.client) {
    console.error(
      await current.client
        .run('document.body.innerText')
        .catch(() => 'Renderer unavailable'),
    );
    await screenshot(current.client, 'failure').catch(() => {});
  }
  throw error;
} finally {
  await terminate();
  await stageLibrary?.close();
  const finalIdentity = await lstat(scratch);
  assert.ok(!finalIdentity.isSymbolicLink());
  assert.equal(finalIdentity.dev, identity.dev);
  assert.equal(finalIdentity.ino, identity.ino);
  assert.equal(await readFile(join(scratch, '.fixture-owner'), 'utf8'), owner);
  await rm(scratch, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 250,
  });
}
