// Actual IntersectionObserver clipping, video metadata/frame reads and React consumers.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = resolve(__dirname, '../..');
const scratch =
  process.env.AFFLATUS_FIXTURE_SCRATCH ??
  mkdtempSync(join(root, 'src/renderer/.thumbnail-controls-'));
const profile =
  process.env.AFFLATUS_FIXTURE_PROFILE ??
  mkdtempSync(join(tmpdir(), 'afflatus-thumbnail-controls-'));
app.setPath('userData', profile);
writeFileSync(
  join(scratch, 'sample.mp4'),
  require('./thumbnail-fixture-video.cjs'),
);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>缩略图资源回归</title></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/thumbnail-visibility-controls.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const run = (source) => win.webContents.executeJavaScript(source);
  const errors = [];
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const wait = async (source, label) => {
    for (let i = 0; i < 500; i++) {
      if (await run(source)) return;
      await sleep(20);
    }
    throw Error(`Timed out: ${label}`);
  };
  const stats = () => run('thumbnailControls.stats()');
  const scroll = (index) =>
    run(`document.querySelector('#clips').scrollLeft=${index}*216`);
  const width = (index) =>
    `thumbnailControls.stats().dimensions[${index}]?.[0]`;
  const load = async () => {
    await win.loadURL(
      `${process.env.AFFLATUS_FIXTURE_ORIGIN ?? 'http://127.0.0.1:5173'}/${basename(scratch)}/index.html`,
    );
    await wait(
      `typeof thumbnailControls!=='undefined' && ${width(0)}===160`,
      'initial visible frame',
    );
  };
  let failed = false;
  try {
    await load();
    await sleep(700);
    let state = await stats();
    assert.equal(state.buttons, 40);
    assert.ok(
      state.frameDecodes <= 3,
      `clipped descendants must not decode: ${state.frameDecodes}`,
    );
    assert.ok(state.dimensions.slice(3).every(([w, h]) => w === 0 && h === 0));
    assert.equal(
      await run('document.querySelectorAll("[data-flip-id]").length'),
      40,
    );
    console.log(
      'PASS real clipping loads only nearby thumbnails while all 40 selected buttons/FLIP targets retain fixed layout and cold canvases have zero pixels',
    );

    const clippedAt = Date.now();
    await scroll(25);
    await wait(`${width(25)}===160`, 'scrolled clip loads');
    await sleep(Math.max(0, 450 - (Date.now() - clippedAt)));
    assert.equal(
      await run(width(0)),
      160,
      'already painted frame survives transition grace',
    );
    await wait(`${width(0)}===0`, 'offscreen frame releases after grace');
    state = await stats();
    const beforeRegroup = state.frameDecodes;
    await run('thumbnailControls.regroup()');
    await wait(`${width(0)}===160`, 'regroup returns warm first clip');
    assert.equal(
      (await stats()).firstPaint[0],
      160,
      'warm regroup paints in layout effect',
    );
    assert.equal((await stats()).frameDecodes, beforeRegroup);
    console.log(
      'PASS horizontal scrolling releases offscreen pixels after 440ms animation grace; regroup paints cached frames before its first layout without re-decoding',
    );

    await scroll(25);
    win.webContents.focus();
    await run(
      'document.querySelector("[data-video-thumbnail]").focus({preventScroll:true})',
    );
    await wait(`${width(0)}===160`, 'focused offscreen clip');
    await wait(
      'document.activeElement===document.querySelector("[data-video-thumbnail]") && document.hasFocus()',
      'actual keyboard focus',
    );
    await sleep(750);
    assert.equal(await run(width(0)), 160);
    await run('document.querySelector("#blur").focus()');
    await wait(`${width(0)}===0`, 'blur releases offscreen focus lease');
    const bounds = await run(
      '(()=>{const r=document.querySelectorAll("[data-video-thumbnail]")[25].getBoundingClientRect();return {x:Math.round(r.x+20),y:Math.round(r.y+50)}})()',
    );
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: 'mouseMove', ...bounds });
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      ...bounds,
    });
    await wait(
      'thumbnailControls.stats().pointerDown==="asset-25"',
      'real pointerdown reaches clip before scrolling',
    );
    await scroll(35);
    await sleep(780);
    assert.equal(
      await run(width(25)),
      160,
      'active hold keeps its original pixels',
    );
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      ...bounds,
    });
    await wait(
      'thumbnailControls.stats().splits===1',
      'long press releases exactly one selected clip',
    );
    await run('document.querySelector("#blur").focus()');
    await wait(`${width(25)}===0`, 'released hold unpins clipped frame');
    console.log(
      'PASS real focus and pointer hold preserve pixels while clipped; releasing the existing hold still splits once and releases its lease',
    );

    await run('thumbnailControls.cover(true); thumbnailControls.editor(true)');
    await wait(
      'thumbnailControls.stats().dimensions.every(([w,h])=>w===0&&h===0)',
      'covered canvas releases immediately',
    );
    const beforeEditor = (await stats()).frameDecodes;
    await wait(
      'thumbnailControls.stats().metadataResult?.length===40',
      'entire sequence metadata',
    );
    state = await stats();
    assert.equal(state.frameDecodes, beforeEditor);
    assert.equal(
      state.metadataReads,
      40 - state.cache.entries,
      'only clips without cached frames create metadata-only readers',
    );
    assert.ok(
      state.metadataResult.every(
        (item) =>
          item.width > 0 &&
          item.height > 0 &&
          item.duration === 1 &&
          !('image' in item),
      ),
    );
    assert.ok(state.peak <= 3);
    assert.equal(state.buttons, 40);
    await run('thumbnailControls.cover(false)');
    await wait(
      `${width(35)}===160`,
      'closing editor resumes cached visible thumbnails',
    );
    console.log(
      'PASS covering main canvas releases bitmaps without removing nodes; full-sequence actual loadedmetadata reads carry numbers only and share the three-video limit',
    );

    await run(
      'thumbnailControls.mount(false); thumbnailControls.editor(false)',
    );
    await wait(
      'thumbnailControls.stats().buttons===0 && thumbnailControls.stats().active===0',
      'unmount drains consumer leases',
    );
    await run(
      'thumbnailControls.clear(); thumbnailControls.delay(true); thumbnailControls.twin(2); thumbnailControls.mount(true)',
    );
    await wait(
      'thumbnailControls.stats().delayed.length===1',
      'two consumers coalesce one pending decoder',
    );
    await run(
      'document.querySelector("[data-video-thumbnail]").focus({preventScroll:true})',
    );
    await sleep(100);
    assert.equal(
      (await stats()).delayed.length,
      1,
      'focus promotion does not restart the decoder',
    );
    assert.equal((await stats()).delayed[0].aborted, false);
    await run('thumbnailControls.twin(1)');
    await wait(
      'thumbnailControls.stats().buttons===1',
      'one shared consumer unmounts',
    );
    assert.equal(
      (await stats()).delayed[0].aborted,
      false,
      'remaining consumer keeps the shared decode',
    );
    await run('thumbnailControls.twin(2)');
    await wait(
      'thumbnailControls.stats().buttons===2',
      'second consumer rejoins',
    );
    assert.equal((await stats()).delayed.length, 1);
    await run('thumbnailControls.repair("asset-0")');
    await wait(
      'thumbnailControls.stats().delayed.length===2',
      'repair starts new key',
    );
    state = await stats();
    assert.equal(state.delayed[0].aborted, true);
    assert.equal(state.delayed[1].aborted, false);
    await run('thumbnailControls.release()');
    await wait(
      `${width(0)}===160 && ${width(1)}===160`,
      'only new revision frame is displayed',
    );
    state = await stats();
    assert.equal(
      state.cache.entries,
      1,
      'cancelled previous revision cannot enter cache',
    );
    await run('thumbnailControls.mount(false)');
    await wait(
      'thumbnailControls.stats().active===0 && thumbnailControls.stats().cache.queued===0',
      'cleanup is idle',
    );
    console.log(
      'PASS shared consumers coalesce; revision change aborts old lease, ignores non-cooperative late result and unmount drains all scheduled work',
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    failed = true;
    console.error(error);
    console.error(errors);
    console.error(await stats().catch(() => null));
  } finally {
    win.destroy();
    try {
      if (!process.env.AFFLATUS_FIXTURE_SCRATCH)
        rmSync(scratch, { recursive: true, force: true });
      if (!process.env.AFFLATUS_FIXTURE_PROFILE)
        rmSync(profile, { recursive: true, force: true });
    } catch (error) {
      failed = true;
      console.error(error);
    } finally {
      app.exit(failed ? 1 : 0);
    }
  }
});
