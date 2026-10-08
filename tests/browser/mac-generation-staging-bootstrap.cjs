// Test-only composition of production services/IPC. No production source hooks.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} = require('node:fs');
const { join, resolve } = require('node:path');
const { Readable } = require('node:stream');
const { app, BrowserWindow, dialog, net, session } = require('electron');
const { require: tsRequire } = require('tsx/cjs/api');
const { marker } = require('../../scripts/mac-acceptance-safety.cjs');

const base = process.argv
  .find((arg) => arg.startsWith('--scratch='))
  ?.slice(10);
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice(7);
assert.ok(base && ['configure', 'reopen'].includes(mode));
assert.equal(realpathSync.native(base), base);
assert.ok(existsSync(join(base, '.fixture-owner')));
assert.equal(process.env.AFFLATUS_USER_DATA, join(base, 'profile'));
assert.equal(process.env.AFFLATUS_PROJECTS_DIR, join(base, 'projects'));
assert.ok(
  globalThis[marker]?.snapshot().installed,
  'Pre-main safeStorage guard required',
);
app.setPath('userData', join(base, 'profile'));
app.setName('Afflatus isolated native generation acceptance');

const source = (path) => tsRequire(`../../${path}`, __filename);
const { Library } = source('src/main/storage/library.ts');
const { registerGenerationIpc } = source(
  'src/main/generation/generation-ipc.ts',
);
const { registerArkIpc } = source('src/main/generation/ark-ipc.ts');
const { ArkGenerationService } = source(
  'src/main/generation/ark-generation-service.ts',
);
const { registerMediaScheme, serveProjectMedia } = source(
  'src/main/desktop/media-protocol.ts',
);
const { newShot, groupMaterials } = source(
  'src/shared/generation/workspace.ts',
);
const { defaultImageParameters } = source(
  'src/shared/generation/image-generation.ts',
);
registerMediaScheme();

const { manifest, text } = JSON.parse(
  readFileSync(join(base, 'inputs.json'), 'utf8'),
);
const evidence = {
  mode,
  checks: [],
  rendererConsole: [],
  deniedNetwork: 0,
  secretStore: 'synthetic-only',
};
const record = (check) => {
  evidence.checks.push(check);
  console.log(`PASS ${check}`);
};
const transportEvent = (method) =>
  appendFileSync(
    join(base, 'transport.jsonl'),
    `${JSON.stringify({ mode, method })}\n`,
  );
const syntheticKey = 'fixture-only-never-a-real-key';
const ciphertext = Buffer.from('fixture-only-ciphertext-v1');
const fakeSecrets = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'fixture-memory-codec',
  encryptString(value) {
    assert.equal(value, syntheticKey);
    return Buffer.from(ciphertext);
  },
  decryptString(value) {
    assert.deepEqual(
      value,
      ciphertext,
      'Only fixture ciphertext may be decoded',
    );
    return syntheticKey;
  },
};
const transport = Object.freeze({
  async createImage(request, key) {
    assert.equal(mode, 'configure');
    assert.equal(request.model, 'ep-fixture-image');
    assert.equal(key, syntheticKey);
    transportEvent('createImage');
    return { url: 'https://fixture.invalid/image.png' };
  },
  async createVideo(request, key) {
    assert.equal(mode, 'configure');
    assert.equal(request.model, 'ep-fixture-video');
    assert.equal(key, syntheticKey);
    transportEvent('createVideo');
    return { id: 'cgt-fixture-video' };
  },
  async getVideo(id, key) {
    assert.equal(mode, 'reopen');
    assert.equal(id, 'cgt-fixture-video');
    assert.equal(key, syntheticKey);
    transportEvent('getVideo');
    return { status: 'succeeded', url: 'https://fixture.invalid/video.mp4' };
  },
  async download(url, kind) {
    assert.equal(
      url,
      `https://fixture.invalid/${kind === 'image' ? 'image.png' : 'video.mp4'}`,
    );
    assert.ok(['image', 'video'].includes(kind));
    transportEvent(`download-${kind}`);
    const extension = kind === 'image' ? 'png' : 'mp4';
    return {
      stream: Readable.from(
        readFileSync(join(base, 'inputs', `reference.${extension}`)),
      ),
      extension,
    };
  },
});
// Ark uses only the injected transport. Any accidental Node network fetch fails.
globalThis.fetch = async () => {
  evidence.deniedNetwork++;
  throw new Error('This fixture prohibits external network requests');
};
let library;
let service;
let win;
let pause;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(25);
  }
  throw new Error(`Timed out: ${label}`);
}
const run = (code) => win.webContents.executeJavaScript(code, true);
const api = (method, ...args) =>
  run(
    `window.desktop.${method}(${args.map((value) => JSON.stringify(value)).join(',')})`,
  );
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function nativeRead(projectId, refs, label) {
  for (const item of refs) {
    const url = `afflatus-media://asset/${projectId}/${item.id}`;
    if (item.kind === 'text') {
      assert.equal(await api('readReferenceText', projectId, item.id), text);
      continue;
    }
    // Electron net.fetch enters the registered production protocol. Renderer
    // file-origin fetch/CORS is not part of this proof; elements below still
    // request and decode their own native image/video/audio resources.
    const full = await net.fetch(url);
    const bytes = Buffer.from(await full.arrayBuffer());
    const head = await net.fetch(url, { method: 'HEAD' });
    const range = await net.fetch(url, { headers: { Range: 'bytes=1-16' } });
    const result = {
      status: full.status,
      hash: digest(bytes),
      head: head.status,
      size: head.headers.get('content-length'),
      range: range.status,
      contentRange: range.headers.get('content-range'),
      bytes: [...new Uint8Array(await range.arrayBuffer())],
    };
    assert.equal(result.status, 200, `${label} ${item.kind}`);
    assert.equal(result.hash, item.sha256);
    assert.equal(result.head, 200);
    assert.equal(result.size, String(item.size));
    assert.equal(result.range, 206);
    assert.equal(result.contentRange, `bytes 1-16/${item.size}`);
    assert.deepEqual(result.bytes, [
      ...readFileSync(join(base, 'inputs', item.name)).subarray(1, 17),
    ]);
    const decoded = await run(`(async () => {
      const kind = ${JSON.stringify(item.kind)};
      const element = document.createElement(kind === 'image' ? 'img' : kind);
      document.body.append(element);
      try {
        return await new Promise((resolve,reject) => {
          const timer = setTimeout(()=>reject(new Error('Native decode timed out: '+kind)), 10000);
          const finish = () => { clearTimeout(timer); resolve(kind === 'image' ? {width:element.naturalWidth,height:element.naturalHeight} : {duration:element.duration,ready:element.readyState,width:element.videoWidth||0}); };
          element.addEventListener(kind === 'image' ? 'load' : 'loadeddata', finish, {once:true});
          element.addEventListener('error', ()=>{clearTimeout(timer);reject(new Error('Native decode failed: '+kind));}, {once:true});
          if (kind !== 'image') { element.preload='auto'; element.muted=true; }
          element.src=${JSON.stringify(url)};
        });
      } finally { if(kind!=='image') { element.pause(); element.removeAttribute('src'); element.load(); } element.remove(); }
    })()`);
    if (item.kind === 'image')
      assert.ok(decoded.width > 0 && decoded.height > 0);
    else {
      assert.ok(decoded.duration > 0 && decoded.ready >= 2);
      if (item.kind === 'video') assert.ok(decoded.width > 0);
    }
  }
  record(
    `${label}: text via production preload/IPC; main Electron net.fetch via production media protocol checks full SHA-256, HEAD and Range; renderer image/video/audio elements decode independently`,
  );
}

async function settle(projectId, id, phase) {
  return waitFor(async () => {
    const jobs = await api('listArkJobs', projectId);
    return jobs.find((job) => job.id === id && job.phase === phase);
  }, `Ark ${phase}`);
}
function generationShot(kind) {
  let shot = newShot(`shot-${kind}`, `模拟${kind}`, {
    x: 300,
    y: kind === 'image' ? 100 : 400,
  });
  shot.nodes.push({
    id: `prompt-${kind}`,
    type: 'text',
    text: '本机模拟生成；不会调用云端。',
    position: { x: 10, y: 10 },
  });
  shot = groupMaterials(shot, [`prompt-${kind}`], `group-${kind}`);
  if (kind === 'image')
    shot.groups[0] = {
      ...shot.groups[0],
      kind: 'image',
      parameters: defaultImageParameters(),
    };
  return shot;
}
async function configure() {
  const { project } = await library.projects.create(
    '原生暂存与模拟生成隔离验收',
  );
  pause = library.saves.pauseLocalReferences();
  await pause.idle();
  const imported = await api('importReferences', project.id, randomUUID());
  assert.deepEqual(imported.errors, []);
  assert.equal(imported.assetIds.length, 4);
  const refs = manifest.map((item, index) => ({
    ...item,
    id: imported.assetIds[index],
  }));
  for (const item of refs) {
    const job = library.store.job(item.id);
    assert.equal(job.status, 'ready');
    assert.equal(job.sha256, item.sha256);
    assert.equal(
      digest(readFileSync(library.staging.path(item.id))),
      item.sha256,
    );
  }
  assert.equal((await library.projects.open(project.id)).assets.length, 0);
  const references = newShot('reference-shot', '四类完整未保存素材', {
    x: 0,
    y: 0,
  });
  references.nodes = refs.map((item, index) => ({
    id: `reference-${index}`,
    type: 'asset',
    assetId: item.id,
    position: { x: index * 100, y: 0 },
  }));
  await api('saveGenerationWorkspace', project.id, {
    version: 1,
    revision: 0,
    shots: [references, generationShot('image'), generationShot('video')],
  });
  await nativeRead(project.id, refs, 'complete but unsaved');

  let releaseMigration;
  const barrier = new Promise((done) => {
    releaseMigration = done;
  });
  let entered = false;
  const beforeMigration = library.backups.beforeMigration.bind(library.backups);
  library.backups.beforeMigration = async (...args) => {
    await beforeMigration(...args);
    entered = true;
    await barrier;
  };
  const preview = await library.migration.prepare(join(base, 'moved'));
  await library.migration.start(preview.token);
  try {
    await waitFor(() => entered, 'production migration admission barrier');
    assert.equal(library.gate.isBlocked, true);
    await nativeRead(
      project.id,
      refs,
      'production migration admitted, writes blocked',
    );
  } finally {
    releaseMigration();
    library.backups.beforeMigration = beforeMigration;
  }
  await library.migration.idle();
  assert.equal(library.state().migration?.phase, 'completed');
  assert.equal(library.store.root, join(base, 'moved'));
  for (const item of refs)
    assert.equal(library.store.job(item.id).status, 'ready');
  await nativeRead(project.id, refs, 'migrated destination, still unsaved');
  pause.resume();
  pause = null;
  await library.saves.idle();
  const snapshot = await library.projects.open(project.id);
  for (const item of refs) {
    assert.equal(library.store.job(item.id).status, 'saved');
    assert.equal(existsSync(library.staging.path(item.id)), false);
    const asset = snapshot.assets.find((value) => value.id === item.id);
    assert.ok(asset);
    assert.equal(
      digest(
        readFileSync(join(base, 'moved', project.folder, asset.relativePath)),
      ),
      item.sha256,
    );
  }
  await nativeRead(project.id, refs, 'saved and staging cleaned');
  await win.loadFile(join(base, 'native.html'));
  await nativeRead(project.id, refs, 'renderer reload after save');

  const config = await api('saveArkConfig', {
    apiKey: syntheticKey,
    models: [
      {
        alias: 'seedream-5.0-lite',
        capability: 'seedream-5.0-lite',
        modelId: 'ep-fixture-image',
      },
      {
        alias: 'seedance-2.0',
        capability: 'seedance-2.0',
        modelId: 'ep-fixture-video',
      },
    ],
  });
  assert.equal(config.hasKey, true);
  assert.equal(JSON.stringify(config).includes(syntheticKey), false);
  const target = (kind) => ({
    projectId: project.id,
    shotId: `shot-${kind}`,
    groupId: `group-${kind}`,
  });
  const imagePreview = await api('previewArkGeneration', target('image'));
  const imageJob = await api('submitArkGeneration', imagePreview.token);
  await assert.rejects(api('submitArkGeneration', imagePreview.token));
  const candidate = await settle(project.id, imageJob.id, 'candidate');
  assert.ok(candidate.candidateAssetId);
  const before = await api('getGenerationWorkspace', project.id);
  assert.equal(
    before.shots.find((shot) => shot.id === 'shot-image').nodes.length,
    1,
    'Candidate is not adopted automatically',
  );
  const adopted = await api('adoptArkJob', imageJob.id, before.revision);
  assert.equal(adopted.kind, 'image');
  assert.equal(adopted.workspace.revision, before.revision + 1);
  assert.equal(
    adopted.workspace.shots.find((shot) => shot.id === 'shot-image').nodes
      .length,
    2,
  );
  assert.deepEqual(
    await api('adoptArkJob', imageJob.id, before.revision),
    adopted,
  );
  const videoPreview = await api('previewArkGeneration', target('video'));
  const videoJob = await api('submitArkGeneration', videoPreview.token);
  await settle(project.id, videoJob.id, 'queued');
  writeFileSync(
    join(base, 'seed.json'),
    JSON.stringify({
      project,
      refs,
      imageJobId: imageJob.id,
      videoJobId: videoJob.id,
      workspace: await api('getGenerationWorkspace', project.id),
      imageAssetId: adopted.assetId,
    }),
    { flag: 'wx' },
  );
  record(
    'production Ark IPC/service: synthetic config, one-use submission, image candidate, explicit/idempotent adoption, video remote ID queued for next process',
  );
}
async function reopen() {
  const seed = JSON.parse(readFileSync(join(base, 'seed.json'), 'utf8'));
  assert.equal(library.store.root, join(base, 'moved'));
  await nativeRead(
    seed.project.id,
    seed.refs,
    'fresh Electron process after migration/save',
  );
  assert.deepEqual(
    await api('getGenerationWorkspace', seed.project.id),
    seed.workspace,
  );
  assert.equal((await api('getArkConfig')).hasKey, true);
  const image = (await api('listArkJobs', seed.project.id)).find(
    (job) => job.id === seed.imageJobId,
  );
  assert.equal(image.phase, 'adopted');
  assert.equal(image.candidateAssetId, seed.imageAssetId);
  // Recovery may already have performed its one scheduled mock GET.
  await api('refreshArkJob', seed.videoJobId);
  const candidate = await settle(seed.project.id, seed.videoJobId, 'candidate');
  const before = await api('getGenerationWorkspace', seed.project.id);
  const adopted = await api('adoptArkJob', candidate.id, before.revision);
  assert.equal(adopted.kind, 'video');
  assert.equal(adopted.workspace.shots.length, before.shots.length + 1);
  assert.equal(adopted.snapshot.canvas.cards.length, 1);
  assert.deepEqual(
    adopted.workspace.shots.slice(0, before.shots.length),
    before.shots,
  );
  assert.deepEqual(
    await api('adoptArkJob', candidate.id, before.revision),
    adopted,
  );
  const events = readFileSync(join(base, 'transport.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  for (const method of [
    'createImage',
    'createVideo',
    'download-image',
    'download-video',
  ])
    assert.equal(
      events.filter((event) => event.method === method).length,
      1,
      method,
    );
  assert.ok(
    events.some(
      (event) => event.mode === 'reopen' && event.method === 'getVideo',
    ),
  );
  assert.equal(
    events.some(
      (event) => event.mode === 'reopen' && event.method.startsWith('create'),
    ),
    false,
  );
  record(
    'fresh-process Ark recovery: synthetic stored config, image adoption persisted, queued video resumes mock GET/download without POST; explicit video adoption and duplicate adoption are stable',
  );
}

(async () => {
  await app.whenReady();
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => {
      evidence.deniedNetwork++;
      callback({ cancel: true });
    },
  );
  library = await Library.open(join(base, 'profile'), join(base, 'projects'));
  // The Library's default Ark service remains empty and unconfigured. Its journal
  // cannot see this separately injected service's synthetic credential/jobs.
  service = new ArkGenerationService({
    userData: join(base, 'cloud'),
    projects: library.projects,
    store: library.store,
    gate: library.gate,
    staging: library.staging,
    saves: library.saves,
    references: library.referenceReads,
    readWorkspace: (id) => library.generation.readWorkspace(id),
    notify: () => {},
    secrets: fakeSecrets,
    transport,
    pollIntervalMs: -1,
  });
  const trustedWindow = (event) => {
    assert.ok(
      !library.isClosing &&
        win &&
        event.sender === win.webContents &&
        event.senderFrame === win.webContents.mainFrame,
      'Production IPC requires this main-frame owner',
    );
    return win;
  };
  registerGenerationIpc(library, trustedWindow);
  registerArkIpc(service, trustedWindow, () => win);
  serveProjectMedia(library);
  let picks = 0;
  dialog.showOpenDialog = async () => {
    assert.equal(mode, 'configure');
    assert.equal(++picks, 1);
    return {
      canceled: false,
      filePaths: manifest.map((item) => join(base, 'inputs', item.name)),
    };
  };
  win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: resolve(__dirname, '../../out/preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (details) => {
    const entry = {
      level: details.level,
      message: details.message,
      lineNumber: details.lineNumber,
      sourceId: details.sourceId,
    };
    evidence.rendererConsole.push(entry);
    console.error(`[renderer-console] ${JSON.stringify(entry)}`);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  await win.loadFile(join(base, 'native.html'));
  await service.recover();
  if (mode === 'configure') await configure();
  else await reopen();
  assert.equal(evidence.deniedNetwork, 0, 'No external network attempts');
  const guard = globalThis[marker].snapshot();
  assert.equal(guard.encryptAttempts, 0);
  assert.equal(guard.decryptAttempts, 0);
  evidence.nativeSafeStorage = guard;
  await service.close();
  await library.close();
  evidence.status = 'passed';
  writeFileSync(join(base, `${mode}.json`), JSON.stringify(evidence, null, 2));
  win.destroy();
  app.exit(0);
})().catch(async (error) => {
  console.error(error);
  evidence.status = 'failed';
  evidence.error = String(error);
  writeFileSync(join(base, `${mode}.json`), JSON.stringify(evidence, null, 2));
  pause?.resume();
  await service?.close().catch(() => {});
  await library?.close().catch(() => {});
  app.exit(1);
});
