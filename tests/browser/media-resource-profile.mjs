// Real production Chromium decoding; no media/decode mocks or development server.
// node --import tsx tests/browser/media-resource-profile.mjs --out=/absolute/out --count=100 --label=before
// A count above 100 requires --resource-limits, after the new bounds are built.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordAsset } from '../../src/main/projects/project-database.ts';
import { Library } from '../../src/main/storage/library.ts';
import { connect, freePort, sleep, waitFor } from './desktop-client.mjs';
import { installMediaResourceObserver } from './media-resource-observer.mjs';
import { captureMediaProcessDiagnostics } from './media-resource-process-diagnostics.mjs';
import { summarizeNativeResources } from './media-resource-summary.mjs';
import { syntheticResourceVideo } from './synthetic-resource-video.mjs';

const option = (key, fallback) =>
  process.argv
    .find((arg) => arg.startsWith(`--${key}=`))
    ?.slice(key.length + 3) ?? fallback;
const count = Number(option('count', '100'));
const bounded = process.argv.includes('--resource-limits');
assert.ok(Number.isInteger(count) && count >= 30 && count <= 1000);
assert.ok(
  count <= 100 || bounded,
  'Old builds must not launch 1000 concurrent thumbnail decoders',
);
const label = option('label', 'sample');
assert.match(label, /^[a-z0-9-]+$/);
const out = resolve(option('out', 'out'));
const executable = createRequire(import.meta.url)('electron');
const scratch = await realpath(
  await mkdtemp(join(tmpdir(), 'afflatus-media-resources-')),
);
const identity = await lstat(scratch);
const owner = randomUUID();
await writeFile(join(scratch, '.fixture-owner'), owner, { flag: 'wx' });
const profile = join(scratch, 'profile');
const projects = join(scratch, 'projects');
const reportsRoot = process.env.AFFLATUS_MEDIA_RESOURCE_REPORTS || tmpdir();
await mkdir(reportsRoot, { recursive: true });
const proof = join(
  await realpath(reportsRoot),
  `afflatus-media-resources-${label}-${count}-${owner}`,
);
await mkdir(proof);
const nativeLog = join(proof, 'native.jsonl');
const reportFile = join(proof, 'report.json');
const json = JSON.stringify;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
let library;
let child;
let exited;
let client;
let log = '';
let project;
let phase = 'seed';
const phases = [];
const resourceAssertions = [];
let original;

async function click(selector) {
  await waitFor(
    () =>
      client.run(
        `!!document.querySelector(${json(selector)}) && !document.querySelector(${json(selector)}).disabled`,
      ),
    `enabled ${selector}`,
  );
  await client.run(`document.querySelector(${json(selector)}).click()`);
}
async function snapshot() {
  return client.run(`window.desktop.openProject(${json(project.id)})`);
}
async function mark(name) {
  await sleep(500);
  const sample = await client.run(
    `window.__mediaResources.mark(${json(name)})`,
  );
  phases.push({ ...sample, wallTime: Date.now() });
  console.log(`RESOURCE ${name} ${json(sample)}`);
  return sample;
}
async function released(ids, reason) {
  await waitFor(
    () =>
      client.run(
        `(() => { const rows = window.__mediaResources.displayCanvases(); return ${json(ids)}.every(id => rows.some(row => row.assetId === id && row.width === 0 && row.height === 0)); })()`,
      ),
    reason,
    10000,
  );
  resourceAssertions.push(reason);
}
async function visiblePainted() {
  return waitFor(
    () =>
      client.run(
        `(() => { const rows = window.__mediaResources.visible(); return rows.length > 0 && rows.every(row => row.painted); })()`,
      ),
    'all actually visible thumbnails painted',
    30000,
  );
}
async function pointerDrag(from, to) {
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    ...from,
  });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...from,
    button: 'left',
    clickCount: 1,
  });
  for (let step = 1; step <= 8; step++)
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + ((to.x - from.x) * step) / 8,
      y: from.y + ((to.y - from.y) * step) / 8,
      button: 'left',
      buttons: 1,
    });
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...to,
    button: 'left',
    clickCount: 1,
  });
}
async function wheel(selector, deltaX) {
  const point = await client.run(
    `(() => { const r = document.querySelector(${json(selector)}).getBoundingClientRect(); return {x:r.x+Math.min(r.width/2,300),y:r.y+r.height/2}; })()`,
  );
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    ...point,
    deltaX,
    deltaY: 0,
  });
  await sleep(400);
}
async function screenshot(name) {
  const result = await client.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(
    join(proof, `${name}.png`),
    Buffer.from(result.data, 'base64'),
  );
}
function comparable(cards) {
  return [...cards].sort((a, b) => a.id.localeCompare(b.id));
}

try {
  library = await Library.open(profile, projects);
  project = (await library.projects.create(`${count} 视频资源实测`)).project;
  const database = await library.projects.databasePath(project.id);
  const assets = [];
  for (let index = 0; index < count; index++) {
    const id = randomUUID();
    const asset = {
      id,
      name: `合法合成视频 ${String(index + 1).padStart(4, '0')}.mp4`,
      relativePath: `assets/videos/${id}.mp4`,
      size: syntheticResourceVideo.length,
      sha256: digest(syntheticResourceVideo),
      kind: 'video',
    };
    await writeFile(
      join(projects, project.folder, asset.relativePath),
      syntheticResourceVideo,
      { flag: 'wx' },
    );
    library.store.putProject(
      recordAsset(database, `resource-fixture:${index}`, asset, project),
    );
    assets.push(asset);
  }
  original = await library.projects.open(project.id);
  const singleCount = Math.max(20, Math.floor(count / 5));
  const singles = assets.slice(0, singleCount).map((asset, index) => ({
    id: asset.id,
    assetIds: [asset.id],
    position: {
      x: 80 + (index % 10) * 330,
      y: 80 + Math.floor(index / 10) * 560,
    },
  }));
  const group = {
    id: randomUUID(),
    assetIds: assets.slice(singleCount).map((asset) => asset.id),
    position: { x: 80, y: 360 },
  };
  original = await library.projects.patchCanvas(project.id, {
    before: original.canvas.cards,
    after: [...singles, group],
  });
  await library.close();
  library = null;
  const sourceHash = digest(syntheticResourceVideo);
  const sourceBefore = assets.map((asset) => ({
    id: asset.id,
    sha256: asset.sha256,
    size: asset.size,
  }));
  const config = join(scratch, 'config.json');
  await writeFile(
    config,
    json({
      scratch,
      owner,
      profile,
      main: join(out, 'main/index.js'),
      nativeLog,
    }),
  );
  const port = await freePort();
  const environment = {
    ...process.env,
    AFFLATUS_USER_DATA: profile,
    AFFLATUS_PROJECTS_DIR: projects,
    AFFLATUS_MEDIA_RESOURCE_FIXTURE: config,
    FFMPEG_PATH: join(scratch, 'absent-optional-ffmpeg'),
    FFPROBE_PATH: join(scratch, 'absent-optional-ffprobe'),
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ELECTRON_RENDERER_URL;
  child = spawn(
    executable,
    [
      fileURLToPath(new URL('./media-resource-bootstrap.cjs', import.meta.url)),
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${port}`,
    ],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  exited = new Promise((resolveClose) => child.once('close', resolveClose));
  let spawnError;
  child.once('error', (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      log = (log + chunk).slice(-30000);
    });
  const target = await waitFor(async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Production exited: ${log}`);
    try {
      return (
        await (
          await fetch(`http://127.0.0.1:${port}/json/list`, {
            signal: AbortSignal.timeout(1000),
          })
        ).json()
      ).find(
        (entry) =>
          entry.type === 'page' && entry.url.includes('/renderer/index.html'),
      );
    } catch {
      return null;
    }
  }, 'production renderer');
  client = await connect(target.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(${installMediaResourceObserver.toString()})()`,
  });
  await client.send('Page.reload');
  await waitFor(
    () =>
      client.run(
        `!!window.__mediaResources && !!document.querySelector('input[aria-label="新项目名称"]')`,
      ),
    'observed project home',
  );
  const build = {
    main: digest(await readFile(join(out, 'main/index.js'))),
    rendererHtml: await readFile(join(out, 'renderer/index.html'), 'utf8'),
  };
  const rendererSources = [
    ...build.rendererHtml.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"/g),
  ].map((match) => match[1]);
  assert.ok(
    rendererSources.length > 0,
    'Production renderer must reference a JavaScript build',
  );
  build.renderer = [];
  for (const source of rendererSources) {
    assert.ok(
      !source.includes('..') && !source.includes(':'),
      'Expected a local renderer build',
    );
    const path = join(out, 'renderer', source.replace(/^\.?\//, ''));
    build.renderer.push({ source, sha256: digest(await readFile(path)) });
  }
  phase = 'first-screen';
  await client.run(
    `window.__mediaResources.begin(); [...document.querySelectorAll('button span')].find(element => element.textContent.trim() === ${json(project.name)}).closest('button').click()`,
  );
  await waitFor(
    () =>
      client.run(`document.querySelectorAll('[data-video-card]').length > 0`),
    'canvas mounted',
  );
  await visiblePainted();
  const firstScreenMs = await client.run('window.__mediaResources.sample().at');
  await mark('first-screen');
  await waitFor(
    () => client.run('window.__mediaResources.sample().activeSources === 0'),
    'initial thumbnails released',
    30000,
  );
  await mark('canvas-settled');
  await screenshot('canvas');

  phase = 'pan-away-and-return';
  const viewportBefore = await client.run(
    `document.querySelector('.react-flow__viewport').style.transform`,
  );
  const pan = await client.run(`(() => {
    const pane = document.querySelector('.react-flow__pane').getBoundingClientRect();
    const y = pane.top + 320;
    return {from:{x:Math.min(innerWidth-80,1250),y},to:{x:250,y}};
  })()`);
  assert.equal(
    await client.run(
      `document.elementFromPoint(${pan.from.x},${pan.from.y})?.classList.contains('react-flow__pane')`,
    ),
    true,
    'The real pan must start on canvas blank space',
  );
  await pointerDrag(pan.from, pan.to);
  await waitFor(
    () =>
      client.run(
        `document.querySelector('.react-flow__viewport').style.transform !== ${json(viewportBefore)}`,
      ),
    'canvas camera actually moved',
  );
  await visiblePainted();
  if (bounded)
    await released(
      [assets[0].id],
      'panned-offscreen display canvas releases its bitmap after grace period',
    );
  await mark('pan-away');
  await pointerDrag(pan.to, pan.from);
  await waitFor(
    () =>
      client.run(
        `document.querySelector('.react-flow__viewport').style.transform === ${json(viewportBefore)}`,
      ),
    'canvas camera returned exactly',
  );
  await visiblePainted();
  await mark('pan-return');
  assert.deepEqual(
    comparable((await snapshot()).canvas.cards),
    comparable(original.canvas.cards),
  );

  phase = 'long-combination-scroll';
  const row = `[data-video-card="${group.id}"] [data-thumbnail-row]`;
  await wheel(row, count * 216);
  await waitFor(
    () => client.run(`document.querySelector(${json(row)}).scrollLeft > 0`),
    'combination scroll',
  );
  await visiblePainted();
  if (bounded)
    await released(
      group.assetIds.slice(0, 4),
      'clipped combination-start display canvases release their bitmaps',
    );
  await mark('combination-end');
  await wheel(row, -count * 216);
  await waitFor(
    () => client.run(`document.querySelector(${json(row)}).scrollLeft === 0`),
    'combination return',
  );
  await visiblePainted();
  await mark('combination-return');

  // 128 real 576x324 RGBA frames exceed the 64 MiB ownership budget.
  // Do not equate still-GC-reachable WeakRef canvases with cache ownership.
  let cachePressure = null;
  if (bounded && count > 100) {
    phase = 'cache-eviction-pressure';
    const probe = group.assetIds[0];
    const before = await client.run(
      `window.__mediaResources.decoded(${json(probe)})`,
    );
    assert.ok(
      before > 0,
      'The LRU probe must first have a genuinely decoded frame',
    );
    const seen = new Set();
    const targetFrames = 128;
    for (let index = 0; index < targetFrames; index += 4) {
      const currentScroll = await client.run(
        `document.querySelector(${json(row)}).scrollLeft`,
      );
      await wheel(row, index * 216 - currentScroll);
      await visiblePainted();
      const visible = await client.run('window.__mediaResources.visible()');
      for (const entry of visible)
        if (group.assetIds.includes(entry.assetId)) seen.add(entry.assetId);
    }
    assert.ok(
      seen.size >= 120,
      `Budget pressure needs at least 120 distinct real frame displays, received ${seen.size}`,
    );
    await released(
      [probe],
      'LRU probe display bitmap released before revisiting',
    );
    const beforeReturn = await client.run(
      `window.__mediaResources.decoded(${json(probe)})`,
    );
    const currentScroll = await client.run(
      `document.querySelector(${json(row)}).scrollLeft`,
    );
    await wheel(row, -currentScroll);
    await visiblePainted();
    const after = await client.run(
      `window.__mediaResources.decoded(${json(probe)})`,
    );
    assert.ok(
      after > beforeReturn,
      'An evicted real thumbnail must decode again when revisited',
    );
    const realFrames = await client.run(
      `window.__mediaResources.result().events.filter(event=>event.type==='draw-video' && event.role==='thumbnail-or-metadata')`,
    );
    const visitedFrames = [...seen].map((id) =>
      realFrames.find((event) => event.source?.includes(`/${id}`)),
    );
    assert.ok(
      visitedFrames.every(
        (event) => event?.width === 576 && event?.height === 324,
      ),
      'Budget pressure must use observed full-size decoded thumbnail canvases',
    );
    cachePressure = {
      distinctFramesDisplayed: seen.size,
      observedDecodedDimensions: [
        ...new Set(
          visitedFrames.map((event) => `${event.width}x${event.height}`),
        ),
      ],
      minimumBytesVisited: visitedFrames.reduce(
        (sum, event) => sum + event.width * event.height * 4,
        0,
      ),
      ownershipBudgetBytes: 64 * 1024 * 1024,
      probeDecodesBefore: before,
      probeDecodesBeforeReturn: beforeReturn,
      probeDecodesAfterReturn: after,
      preciseOwnershipAccounting:
        'Validated separately by ThumbnailCache.stats unit tests; the real browser assertion proves pressure and eviction, not ownership from GC reachability',
    };
    resourceAssertions.push(
      'more than 64 MiB of distinct real thumbnail pixels visited; first frame evicted and decoded again',
    );
    await mark('cache-pressure-return');
  }

  phase = 'complete-sequence-editor';
  await waitFor(
    () =>
      client.run('window.__mediaResources.sample().activeManagedSources === 0'),
    'canvas reader drain before metadata phase',
  );
  const metadataStart = await client.run(
    'window.__mediaResources.checkpoint()',
  );
  const editorStart = Date.now();
  await click(`[data-video-card="${group.id}"] button[aria-label^="播放组合"]`);
  await waitFor(
    () => client.run(`!!document.querySelector('[aria-label="组合播放时间"]')`),
    'complete editor metadata',
    count > 100 ? 120000 : 30000,
  );
  const editorReadyMs = Date.now() - editorStart;
  const metadataEvents = await client.run(
    `window.__mediaResources.since(${metadataStart.eventIndex})`,
  );
  const metadataReads = metadataEvents.filter(
    (event) => event.type === 'src' && event.role === 'thumbnail-or-metadata',
  );
  const metadataFrameDraws = metadataEvents.filter(
    (event) =>
      event.type === 'draw-video' && event.role === 'thumbnail-or-metadata',
  );
  if (bounded) {
    assert.ok(
      metadataReads.length > 0,
      'The sequence must include actual uncached metadata reads',
    );
    assert.ok(
      metadataReads.every((event) => event.preload === 'metadata'),
      'Sequence metadata must not request full first-frame decoding',
    );
    assert.equal(
      metadataFrameDraws.length,
      0,
      'Sequence metadata must not draw video frames into canvases',
    );
    resourceAssertions.push(
      'uncached complete-sequence reads use native preload=metadata with zero video-to-canvas draws',
    );
  }
  const total = await client.run(
    `Number(document.querySelector('[aria-label="播放位置"]').getAttribute('aria-valuemax'))`,
  );
  assert.equal(total, group.assetIds.length * 8);
  assert.equal(
    await client.run(
      `document.querySelectorAll('[data-timeline-clip]').length`,
    ),
    group.assetIds.length,
  );
  if (bounded) {
    await released(
      assets.map((asset) => asset.id),
      'full-screen editor releases every background display bitmap',
    );
    assert.equal(
      await client.run(
        `window.__mediaResources.displayCanvases().reduce((sum,row)=>sum+row.width*row.height,0)`,
      ),
      0,
    );
  }
  await mark('editor-open');
  await screenshot('editor');
  const first = group.assetIds[0];
  const grip = `[data-timeline-clip="${first}"] [aria-label="片段起点"]`;
  await waitFor(
    () =>
      client.run(
        `!!document.querySelector(${json(grip)}) && !document.querySelector(${json(grip)}).disabled`,
      ),
    'trim available',
  );
  const rect = await client.run(
    `(() => { const r=document.querySelector('[data-timeline-clip="${first}"]').getBoundingClientRect(); return {x:r.x+6,y:r.y+r.height/2,width:r.width}; })()`,
  );
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: rect.x,
    y: rect.y,
  });
  await waitFor(
    () =>
      client.run(
        `getComputedStyle(document.querySelector(${json(grip)})).pointerEvents === 'auto'`,
      ),
    'trim hover',
  );
  await pointerDrag(
    { x: rect.x, y: rect.y },
    { x: rect.x + Math.min(24, rect.width / 4), y: rect.y },
  );
  await waitFor(
    async () =>
      (await snapshot()).canvas.cards.find((card) => card.id === group.id)
        .trims?.[first]?.start > 0,
    'real completed trim saved',
  );
  const trimmed = await snapshot();
  assert.deepEqual(trimmed.assets, original.assets);
  assert.deepEqual(
    trimmed.canvas.cards.filter((card) => card.id !== group.id),
    original.canvas.cards.filter((card) => card.id !== group.id),
  );
  await mark('editor-trimmed');
  await click('[aria-label="视频播放与编辑"] button[aria-label="撤销"]');
  await waitFor(
    async () =>
      !(await snapshot()).canvas.cards.find((card) => card.id === group.id)
        .trims?.[first],
    'trim undo persisted',
  );
  assert.equal(
    await client.run(
      `Number(document.querySelector('[aria-label="播放位置"]').getAttribute('aria-valuemax'))`,
    ),
    total,
  );
  await click('[aria-label="视频播放与编辑"] button[aria-label="返回画布"]');
  await waitFor(
    () =>
      client.run(`!document.querySelector('[aria-label="视频播放与编辑"]')`),
    'editor closed',
  );
  await mark('editor-closed');

  phase = 'select-middle-group-member';
  await click(
    `[data-video-card="${group.id}"] [data-asset-id="${group.assetIds[1]}"]`,
  );
  await waitFor(
    () =>
      client.run(
        `!![...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='拆分选中片段'&&!button.disabled)`,
      ),
    'split available',
  );
  phase = 'click-split-middle-group-member';
  const splitStarted = Date.now();
  await client.run(
    `[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='拆分选中片段').click()`,
  );
  phase = 'await-split-database-snapshot';
  await waitFor(
    async () =>
      (await snapshot()).canvas.cards.length ===
      original.canvas.cards.length + 2,
    'only selected middle clip split',
  );
  const splitReadyMs = Date.now() - splitStarted;
  phase = 'click-undo-regroup';
  const regroupStarted = Date.now();
  await click('[aria-label="画布操作"] button[aria-label="撤销"]');
  phase = 'await-regroup-database-snapshot';
  await waitFor(
    async () =>
      (await snapshot()).canvas.cards.length === original.canvas.cards.length,
    'regroup undo',
  );
  const regroupUndoReadyMs = Date.now() - regroupStarted;
  assert.deepEqual(
    comparable((await snapshot()).canvas.cards),
    comparable(original.canvas.cards),
  );
  await mark('regroup-undone');
  const sourceAfter = [];
  for (const asset of assets) {
    const bytes = await readFile(
      join(projects, project.folder, asset.relativePath),
    );
    sourceAfter.push({
      id: asset.id,
      sha256: digest(bytes),
      size: bytes.length,
    });
  }
  assert.deepEqual(sourceAfter, sourceBefore);
  assert.deepEqual(client.errors, []);
  const observation = await client.run('window.__mediaResources.result()');
  const nativeResources = summarizeNativeResources(
    (await readFile(nativeLog, 'utf8')).trim().split('\n').map(JSON.parse),
    phases,
    observation,
  );
  if (bounded) {
    assert.ok(
      observation.managedActivePeak > 0 && observation.managedActivePeak <= 3,
      `Shared thumbnail+metadata reader peak was ${observation.managedActivePeak}, expected 1..3`,
    );
    resourceAssertions.push(
      'shared thumbnail and metadata source-active peak never exceeds 3',
    );
    assert.equal(
      observation.events.filter((event) => event.type === 'error').length,
      0,
      'Real media elements must not report decoder/load errors',
    );
    assert.ok(
      nativeResources.pipelines.length > 0,
      'Chromium Media must confirm actual video decoding',
    );
  }
  await writeFile(
    reportFile,
    json(
      {
        label,
        count,
        out,
        build,
        platform: process.platform,
        source: {
          description:
            'Real fixed H.264 baseline, solid blue, 640x360, 12fps, 8s, no audio; not a 4K or complex codec workload',
          sha256: sourceHash,
          verifiedFiles: assets.length,
        },
        firstScreenMs,
        editorReadyMs,
        splitReadyMs,
        regroupUndoReadyMs,
        fullSequenceDuration: total,
        phases,
        observation,
        nativeResources,
        metadataPhase: {
          actualReads: metadataReads.length,
          frameDraws: metadataFrameDraws.length,
          start: metadataStart,
        },
        resourceLimits: {
          enabled: bounded,
          assertions: resourceAssertions,
          cachePressure,
        },
        assertions: [
          'visible thumbnails paint',
          'pan and scroll return preserve cards',
          'all sequence durations present',
          'real pointer trim commits and undo restores',
          'middle split and undo restore exact card content',
          'all source bytes unchanged',
          'renderer runtime exceptions absent',
        ],
        measurementLimits: [
          'source-active video elements are not decoder counts',
          'CDP Media events identify real Chromium players and decoder names; they do not expose an exact OS decoder resource census',
          'canvas pixels are width*height on observed live WeakRefs, including DOM and detached frames, and may include objects awaiting GC; this is not RSS',
          'canvasPixels includes default-dimension elements without contexts; initializedCanvasPixels separately counts canvases where the application actually requested a rendering context, still not an RSS estimate',
          'process workingSetSize is recorded separately by Electron in KiB, not derived from canvas pixels',
          'optional proxy generation disabled; all real preview decoding uses original media',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS ${count} actual video assets: complete duration, trim/undo, split/undo, pan/scroll return, source hashes`,
  );
  console.log(`REPORT ${reportFile}`);
} catch (error) {
  console.error(`Media resource profiling failed during ${phase}`, error);
  console.error(log);
  await captureMediaProcessDiagnostics({
    child,
    nativeLog,
    directory: proof,
    phase,
  }).catch((diagnosticError) => {
    console.error('OS failure diagnostics unavailable', diagnosticError);
  });
  if (client) {
    console.error(
      await client
        .run('document.body.innerText')
        .catch(() => 'renderer unavailable'),
    );
    await screenshot('failure').catch(() => {});
    await writeFile(
      join(proof, 'partial.json'),
      json(
        await client.run('window.__mediaResources?.result()').catch(() => null),
        null,
        2,
      ),
    );
  }
  throw error;
} finally {
  client?.close();
  if (child && child.exitCode === null && child.signalCode === null)
    child.kill('SIGKILL');
  if (exited) await exited;
  if (library) await library.close();
  await writeFile(join(proof, 'electron.log'), log);
  const current = await lstat(scratch);
  assert.equal(current.dev, identity.dev);
  assert.equal(current.ino, identity.ino);
  assert.equal(await readFile(join(scratch, '.fixture-owner'), 'utf8'), owner);
  await rm(scratch, { recursive: true, maxRetries: 5, retryDelay: 100 });
}
