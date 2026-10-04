// GitHub-hosted Windows runners only. Never run against an existing installation/profile.
// After package:local: node --import tsx tests/browser/windows-installation.mjs
// NSIS /S, final unquoted /D= and _?=: https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage
// Builder 26.15.3 templates: common.nsh, multiUser.nsh, uninstaller.nsh.
// This verifies SAME-VERSION reinstall, not migration from a historical release.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppStore } from '../../src/main/storage/app-store.ts';
import {
  emptyWorkspace,
  newShot,
} from '../../src/shared/generation/workspace.ts';
import { connect, freePort, waitFor } from './desktop-client.mjs';

assert.equal(
  process.platform,
  'win32',
  'Installation checks are forbidden outside Windows CI',
);
assert.equal(
  process.env.GITHUB_ACTIONS,
  'true',
  'A GitHub Actions runner is required',
);
assert.equal(
  process.env.RUNNER_ENVIRONMENT,
  'github-hosted',
  'Self-hosted/user computers are forbidden',
);
assert.equal(process.env.RUNNER_OS, 'Windows');
assert.equal(
  process.argv.length,
  2,
  'This test accepts no installer or directory overrides',
);

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const config = require('../../electron-builder.config.cjs');
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(metadata.devDependencies['electron-builder'], '26.15.3');
assert.equal(config.appId, 'com.infiniteafflatus.desktop');
assert.equal(config.productName, 'Infinite Afflatus');
assert.equal(config.nsis.perMachine, false);
assert.equal(config.nsis.runAfterFinish, false);
assert.equal(config.nsis.deleteAppDataOnUninstall, false);
assert.equal(config.nsis.guid, undefined);
assert.equal(config.win.signExecutable, false);
const name = config.productName;
const runnerTemp = await realpath(requiredDirectory('RUNNER_TEMP'));
// NSIS forbids quotes around final /D=. The controlled hosted-runner path must need none.
assert.doesNotMatch(
  runnerTemp,
  /[\s"]/u,
  'RUNNER_TEMP must permit an unquoted NSIS target',
);
for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
  if (process.env[key]) {
    const protectedDirectory = await realpath(process.env[key]);
    assert.notEqual(runnerTemp.toLowerCase(), protectedDirectory.toLowerCase());
    assert.equal(
      Boolean(isInside(protectedDirectory, runnerTemp)),
      false,
      'Program Files must never be an installation test target',
    );
  }
}
const appData = await realpath(requiredDirectory('APPDATA'));
const profile = join(appData, name);
// app.setName in the real main and getAppInfo below establish the default profile identity.
// Refuse both possible old package-name and current product-name profiles, even empty ones.
await requireMissing(profile);
await requireMissing(join(appData, metadata.name));
const installer = await realpath(
  join(
    root,
    'release',
    `${name}-${metadata.version}-internal-win-${process.arch}.exe`,
  ),
);
assert.ok((await lstat(installer)).isFile());
assert.ok(isInside(await realpath(join(root, 'release')), installer));

const systemRoot = requiredDirectory('SystemRoot');
const reg = join(systemRoot, 'System32', 'reg.exe');
// UUID.v5(appId, electron-builder namespace 50e065bc-3134-11e6-9bab-38c9862bdaf3).
const guid = '506b4124-8330-533d-ae36-895dad0ba0c0';
const registryKeys = [
  `Software\\${guid}`,
  `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`,
];
for (const hive of ['HKCU', 'HKLM']) {
  for (const key of registryKeys) {
    for (const view of ['32', '64']) {
      const result = await command(
        reg,
        ['query', `${hive}\\${key}`, `/reg:${view}`],
        15000,
      );
      assert.equal(
        result.code,
        1,
        `Existing installation registry key: ${hive}\\${key}`,
      );
      assert.match(
        result.output,
        /unable to find the specified registry key/i,
        'Registry preflight must prove absence',
      );
    }
  }
}

const scratch = await realpath(
  await mkdtemp(join(runnerTemp, 'afflatus-install-')),
);
assert.ok(isInside(runnerTemp, scratch));
const install = join(scratch, 'application');
const projects = join(scratch, 'projects');
const executable = join(install, `${name}.exe`);
const uninstaller = join(install, `Uninstall ${name}.exe`);
const owned = [];
let current;
let installed = false;
let uninstalled = false;
const owner = randomUUID();

function requiredDirectory(key) {
  const path = process.env[key];
  assert.ok(
    path && isAbsolute(path),
    `${key} must be an absolute existing directory`,
  );
  return path;
}
function isInside(parent, path) {
  const part = relative(parent, path);
  return (
    part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
  );
}
async function optionalStat(path) {
  return lstat(path).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
}
async function requireMissing(path) {
  assert.equal(
    await optionalStat(path),
    null,
    `Refusing existing path: ${path}`,
  );
}
async function claimDirectory(path, alreadyCreated = false) {
  if (!alreadyCreated) await mkdir(path);
  const identity = await lstat(path);
  assert.ok(identity.isDirectory() && !identity.isSymbolicLink());
  const marker = join(path, '.afflatus-installation-test-owner');
  await writeFile(marker, owner, { flag: 'wx' });
  owned.push({ path, identity, marker });
}
async function cleanupOwned() {
  for (const entry of owned.toReversed()) {
    const actual = await optionalStat(entry.path);
    if (!actual) continue;
    assert.ok(actual.isDirectory() && !actual.isSymbolicLink());
    assert.equal(
      actual.dev,
      entry.identity.dev,
      `Cleanup ownership changed: ${entry.path}`,
    );
    assert.equal(
      actual.ino,
      entry.identity.ino,
      `Cleanup ownership changed: ${entry.path}`,
    );
    assert.equal(await readFile(entry.marker, 'utf8'), owner);
    await rm(entry.path, { recursive: true, maxRetries: 8, retryDelay: 250 });
  }
}
function command(file, args, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        output = (output + chunk).slice(-16000);
      });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Command timed out: ${file}`));
      else resolve({ code, signal, output });
    });
  });
}
async function installSameVersion() {
  installed = true;
  const result = await command(installer, [
    '/S',
    '/currentuser',
    `/D=${install}`,
  ]);
  assert.equal(result.code, 0, result.output || 'NSIS installation failed');
  assert.ok((await lstat(executable)).isFile());
  assert.ok((await lstat(uninstaller)).isFile());
  assert.equal(await realpath(executable), executable);
}
async function uninstall() {
  // _?= suppresses NSIS's detached copy-and-relaunch. Run a copy outside the target
  // so the uninstaller can remove every installed file while this process awaits it.
  const copy = join(scratch, 'verified-uninstaller.exe');
  await copyFile(uninstaller, copy);
  assert.deepEqual(await readFile(copy), await readFile(uninstaller));
  const result = await command(copy, ['/S', '/currentuser', `_?=${install}`]);
  assert.equal(result.code, 0, result.output || 'NSIS uninstallation failed');
  await requireMissing(executable);
  await requireMissing(join(install, 'resources', 'app.asar'));
  uninstalled = true;
}
async function launch() {
  const port = await freePort();
  const env = { ...process.env };
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_RENDERER_URL',
    'AFFLATUS_USER_DATA',
    'AFFLATUS_PROJECTS_DIR',
  ])
    delete env[key];
  // Deliberately no --user-data-dir: uninstall must retain the actual default profile.
  const child = spawn(
    executable,
    ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`],
    { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-16000);
    });
  current = {
    child,
    client: null,
    exited: new Promise((resolve) => child.once('close', resolve)),
  };
  const target = await waitFor(async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null)
      throw new Error(`Installed app exited: ${output}`);
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
  }, 'installed application renderer');
  const client = await connect(target.webSocketDebuggerUrl);
  current.client = client;
  await waitFor(
    () =>
      client.run(`!!document.querySelector('input[aria-label="新项目名称"]')`),
    'installed project home',
  );
  assert.deepEqual(await client.run('window.desktop.getAppInfo()'), {
    name,
    version: metadata.version,
    platform: 'win32',
  });
  assert.equal(
    (await client.run('window.desktop.getLibrary()')).root,
    projects,
    'Refusing writes outside the isolated project root',
  );
  return client;
}
async function stop() {
  if (!current) return;
  const running = current;
  if (running.child.exitCode === null && running.child.signalCode === null) {
    if (running.client)
      void running.client.run('window.close()').catch(() => undefined);
    else running.child.kill('SIGKILL');
    await waitFor(
      () =>
        running.child.exitCode !== null || running.child.signalCode !== null,
      'installed app quit',
      15000,
    ).catch((error) => {
      running.child.kill('SIGKILL');
      throw error;
    });
  }
  await running.exited;
  running.client?.close();
  current = null;
  assert.equal(
    running.child.exitCode,
    0,
    'The installed app must quit normally before reinstall/uninstall',
  );
}
async function contentSnapshot(directory) {
  const result = {};
  async function visit(path, prefix) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assert.equal(
        entry.isSymbolicLink(),
        false,
        'Test data must not contain links',
      );
      const full = join(path, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(full, key);
      else if (entry.isFile())
        result[key] = createHash('sha256')
          .update(await readFile(full))
          .digest('hex');
    }
  }
  await visit(directory, '');
  return result;
}

try {
  await claimDirectory(scratch, true);
  await claimDirectory(profile);
  await mkdir(install);
  assert.deepEqual(await readdir(install), []);
  await mkdir(projects);
  new AppStore(join(profile, 'app.sqlite'), projects).close();
  await installSameVersion();
  const first = await launch();
  const project = await first.run(
    `window.desktop.createProject('Windows 同版覆盖安装回归')`,
  );
  const shot = newShot(randomUUID(), '已保存镜头', { x: 50, y: 70 });
  shot.nodes.push({
    id: randomUUID(),
    type: 'text',
    text: '覆盖安装后仍然存在的镜头文字',
    position: { x: 90, y: 110 },
  });
  const workspace = await first.run(
    `window.desktop.saveGenerationWorkspace(${JSON.stringify(project.project.id)}, ${JSON.stringify({ ...emptyWorkspace(), shots: [shot] })})`,
  );
  const settings = {
    ...(await first.run('window.desktop.getLibrary()')).interactions,
    longPressSplit: false,
  };
  await first.run(
    `window.desktop.saveInteractions(${JSON.stringify(settings)})`,
  );
  const draft = structuredClone(workspace);
  draft.shots[0].nodes[0].text = '尚未写入项目但已保护的恢复草稿';
  const draftInput = {
    sessionId: randomUUID(),
    seq: 1,
    baseline: workspace,
    workspace: draft,
  };
  await first.run(
    `window.desktop.protectWorkspaceDraft(${JSON.stringify(project.project.id)}, ${JSON.stringify(draftInput)})`,
  );
  // This fixture has no video assets. Seed a real name record through the
  // installed preload; actual trim recovery is covered by the desktop test.
  const nameInput = {
    kind: 'name',
    sessionId: randomUUID(),
    seq: 1,
    baseline: project.project.name,
    target: '覆盖安装后仍可继续修改的项目名称',
  };
  assert.equal(
    await first.run(
      `window.desktop.protectProjectEditDraft(${JSON.stringify(project.project.id)}, ${JSON.stringify(nameInput)})`,
    ),
    nameInput.seq,
  );
  const editDrafts = await first.run(
    `window.desktop.listProjectEditDrafts(${JSON.stringify(project.project.id)})`,
  );
  assert.deepEqual(editDrafts.issues, []);
  assert.equal(editDrafts.drafts.length, 1);
  assert.deepEqual(editDrafts.drafts[0], {
    ...nameInput,
    format: 'infinite-afflatus-project-edit-draft',
    version: 1,
    project: {
      id: project.project.id,
      folder: project.project.folder,
      name: project.project.name,
    },
    updatedAt: editDrafts.drafts[0].updatedAt,
  });
  assert.deepEqual(first.errors, []);
  await stop();
  const firstDrafts = await contentSnapshot(join(profile, 'workspace-drafts'));
  assert.ok(Object.keys(firstDrafts).length > 0);
  const editDraftDirectory = join(profile, 'project-edit-drafts');
  const firstEditDraftFiles = await contentSnapshot(editDraftDirectory);
  assert.equal(Object.keys(firstEditDraftFiles).length, 1);
  const beforeReinstallProjects = await contentSnapshot(projects);
  await installSameVersion();
  assert.deepEqual(await contentSnapshot(projects), beforeReinstallProjects);
  assert.deepEqual(
    await contentSnapshot(join(profile, 'workspace-drafts')),
    firstDrafts,
  );
  assert.deepEqual(
    await contentSnapshot(editDraftDirectory),
    firstEditDraftFiles,
    'Same-version overwrite changed a project-edit recovery file',
  );
  const second = await launch();
  const state = await second.run('window.desktop.getLibrary()');
  assert.equal(state.projects.length, 1);
  assert.equal(state.projects[0].id, project.project.id);
  assert.deepEqual(state.interactions, settings);
  assert.deepEqual(
    await second.run(
      `window.desktop.getGenerationWorkspace(${JSON.stringify(project.project.id)})`,
    ),
    workspace,
  );
  const drafts = await second.run(
    `window.desktop.listWorkspaceDrafts(${JSON.stringify(project.project.id)})`,
  );
  assert.deepEqual(drafts.issues, []);
  assert.equal(drafts.drafts.length, 1);
  assert.deepEqual(drafts.drafts[0].workspace, draft);
  assert.deepEqual(
    await second.run(
      `window.desktop.listProjectEditDrafts(${JSON.stringify(project.project.id)})`,
    ),
    editDrafts,
    'Reopening changed the original name recovery record or its timestamp',
  );
  assert.equal(state.projects[0].name, project.project.name);
  assert.deepEqual(second.errors, []);
  await stop();
  assert.deepEqual(
    await contentSnapshot(editDraftDirectory),
    firstEditDraftFiles,
    'Reading project-edit recovery after reinstall rewrote its original bytes',
  );
  console.log(
    'PASS Windows NSIS install and SAME-VERSION overwrite reopen the saved project, settings and protected draft using the default profile',
  );
  const profileBeforeUninstall = await contentSnapshot(profile);
  const projectsBeforeUninstall = await contentSnapshot(projects);
  await uninstall();
  assert.deepEqual(
    await contentSnapshot(editDraftDirectory),
    firstEditDraftFiles,
    'Uninstall changed the protected project-name recovery file',
  );
  assert.deepEqual(
    await contentSnapshot(profile),
    profileBeforeUninstall,
    'Uninstall changed the actual default profile',
  );
  assert.deepEqual(
    await contentSnapshot(projects),
    projectsBeforeUninstall,
    'Uninstall changed the project library',
  );
  console.log(
    'PASS NSIS uninstall removes the installed executable/ASAR and preserves all default-profile and project bytes; historical-version upgrades and signing remain unverified',
  );
} finally {
  await stop();
  if (installed && !uninstalled && (await optionalStat(uninstaller)))
    await uninstall();
  await cleanupOwned();
}
