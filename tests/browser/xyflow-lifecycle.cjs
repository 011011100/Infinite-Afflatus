// Exercise the actual React Flow dependency while recording native observer ownership.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow } = require('electron');
const root = resolve(__dirname, '../..');
const scratch =
  process.env.AFFLATUS_FIXTURE_SCRATCH ??
  mkdtempSync(join(root, 'src/renderer/.xyflow-lifecycle-'));
const profile =
  process.env.AFFLATUS_FIXTURE_PROFILE ??
  mkdtempSync(join(tmpdir(), 'afflatus-xyflow-lifecycle-'));
app.setPath('userData', profile);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>画布观察器回归</title></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/xyflow-lifecycle.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  const run = (source) => win.webContents.executeJavaScript(source);
  const errors = [];
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const wait = async (source, label) => {
    for (let i = 0; i < 200; i++) {
      if (await run(source)) return;
      await sleep(20);
    }
    throw Error(`Timed out: ${label}`);
  };
  const stats = () => run('xyflowControls.stats()');
  let failed = false;
  try {
    await win.loadURL(
      `${process.env.AFFLATUS_FIXTURE_ORIGIN ?? 'http://127.0.0.1:5173'}/${basename(scratch)}/index.html`,
    );
    await wait('xyflowControls.dimensions().width===800', 'initial dimensions');
    await wait(
      'xyflowControls.stats().active===3',
      'StrictMode retains exactly three active observers',
    );
    for (let round = 0; round < 3; round++) {
      await run('xyflowControls.show(false)');
      await wait(
        'xyflowControls.stats().active===0',
        'unmount disconnects every observer',
      );
      const deliveriesAfterDisposal = (await stats()).detachedDeliveries;
      await sleep(50);
      assert.equal((await stats()).detachedTargets, 0);
      assert.equal((await stats()).detachedDeliveries, deliveriesAfterDisposal);
      await run('xyflowControls.show(true)');
      await wait(
        'xyflowControls.stats().active===3',
        'reopening owns fresh observers',
      );
    }
    console.log(
      'PASS StrictMode and repeated canvas mount/unmount release all observers without orphaned deliveries after disposal',
    );
    await run('xyflowControls.reset()');
    const wc = win.webContents;
    wc.sendInputEvent({ type: 'mouseMove', x: 400, y: 300 });
    wc.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      clickCount: 1,
      x: 400,
      y: 300,
    });
    wc.sendInputEvent({
      type: 'mouseMove',
      modifiers: ['leftButtonDown'],
      x: 500,
      y: 350,
    });
    await wait(
      'xyflowControls.selectionActive()',
      'real drag enters native box selection',
    );
    await run('xyflowControls.resize(960,600)');
    await wait(
      'xyflowControls.dimensions().width===960 && xyflowControls.dimensions().height===600',
      'container resizes during selection',
    );
    assert.equal(
      (await stats()).active,
      3,
      'temporary pan/zoom unbinding must not dispose its extent observer',
    );
    wc.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      clickCount: 1,
      x: 500,
      y: 350,
    });
    await wait('!xyflowControls.selectionActive()', 'selection ends');
    await run('xyflowControls.reset()');
    await run('xyflowControls.zoom()');
    await wait(
      'xyflowControls.viewport().zoom===2',
      'zoom resumes after selection',
    );
    let viewport = await run('xyflowControls.viewport()');
    assert.ok(
      Math.abs(viewport.x + 480) < 1 && Math.abs(viewport.y + 300) < 1,
      'zoom uses the new extent center after internal selection unbind',
    );
    await run('xyflowControls.resize(700,400)');
    await wait(
      'xyflowControls.dimensions().width===700 && xyflowControls.dimensions().height===400',
      'later dimensions remain observed',
    );
    await run('xyflowControls.reset()');
    await run('xyflowControls.zoom()');
    viewport = await run('xyflowControls.viewport()');
    assert.ok(
      Math.abs(viewport.x + 350) < 1 && Math.abs(viewport.y + 200) < 1,
      'later zoom uses later dimensions',
    );
    console.log(
      'PASS native box selection preserves resize observation and resumed zoom uses the resized center',
    );
    const beforeBurst = await stats();
    await run('xyflowControls.resizeBurst(720,740)');
    await wait(
      'xyflowControls.dimensions().width===740',
      'latest resize in burst',
    );
    const afterBurst = await stats();
    assert.equal(afterBurst.dimensionWrites - beforeBurst.dimensionWrites, 1);
    assert.equal(
      afterBurst.scheduledResizeFrames - beforeBurst.scheduledResizeFrames,
      1,
    );
    assert.equal(
      afterBurst.writesDuringDelivery,
      0,
      'container size is never published while native observers are being notified',
    );
    await run(
      'xyflowControls.unmountOnResize(); xyflowControls.resize(760,420)',
    );
    await wait(
      'xyflowControls.stats().active===0',
      'resize-triggered final teardown',
    );
    const disposed = await stats();
    assert.equal(disposed.pendingResizeFrames, 0);
    assert.ok(
      disposed.cancelledResizeFrames > afterBurst.cancelledResizeFrames,
      'teardown cancels the already scheduled container measurement',
    );
    await sleep(50);
    const afterDisposal = await stats();
    assert.equal(afterDisposal.detachedDeliveries, disposed.detachedDeliveries);
    assert.equal(
      afterDisposal.dimensionWrites,
      disposed.writesAtDisposal,
      'disposed canvas never publishes another size',
    );
    console.log(
      'PASS rapid size changes publish one final size outside observer delivery; unmount cancels pending measurement',
    );
    await run(
      'xyflowControls.show(true); xyflowControls.reportNodeMeasurements(true)',
    );
    await wait(
      'xyflowControls.stats().active===3',
      'reopened measurement view',
    );
    await run('xyflowControls.resizeNode(160)');
    await wait(
      'xyflowControls.dimensions().height===392',
      'measured node summary changes the ancestor pane height',
    );
    assert.equal(
      (await stats()).nodeWritesDuringDelivery,
      0,
      'node measurements are never published while native observers are being notified',
    );
    assert.equal(await run('xyflowControls.nodeWidth()'), 160);
    assert.deepEqual(
      errors,
      [],
      'node summary changes the pane without native warnings',
    );
    const beforeNodeBurst = await stats();
    await run('xyflowControls.resizeNode(180); xyflowControls.resizeNode(200)');
    await wait(
      'xyflowControls.nodeWidth()===200',
      'latest node width in burst',
    );
    const afterNodeBurst = await stats();
    assert.equal(
      afterNodeBurst.nodeDimensionWrites - beforeNodeBurst.nodeDimensionWrites,
      1,
    );
    assert.equal(
      afterNodeBurst.scheduledResizeFrames -
        beforeNodeBurst.scheduledResizeFrames,
      1,
    );
    // Remove the optional summary before explicitly tearing down a node inside
    // delivery; the fixture's own teardown must not resize an observed ancestor.
    await run('xyflowControls.reportNodeMeasurements(false)');
    await wait('xyflowControls.dimensions().height===420', 'summary closes');
    await run(
      'xyflowControls.replaceOnNodeResize(); xyflowControls.resizeNode(210)',
    );
    await wait(
      'xyflowControls.stats().replacementIsNew && xyflowControls.nodeWidth()===100',
      'replaced same-id node keeps its own measurement',
    );
    const replaced = await stats();
    assert.deepEqual(replaced.nodeMeasurements, [100]);
    assert.ok(
      replaced.cancelledResizeFrames > afterNodeBurst.cancelledResizeFrames,
    );
    assert.equal(replaced.nodeWritesDuringDelivery, 0);
    assert.deepEqual(
      errors,
      [],
      'same-id node replacement has no native warnings',
    );
    await run(
      'xyflowControls.unmountOnNodeResize(); xyflowControls.resizeNode(220)',
    );
    await wait('xyflowControls.stats().active===0', 'node-triggered teardown');
    const nodeDisposed = await stats();
    assert.equal(nodeDisposed.pendingResizeFrames, 0);
    assert.ok(
      nodeDisposed.cancelledResizeFrames > replaced.cancelledResizeFrames,
    );
    await sleep(50);
    assert.equal(
      (await stats()).nodeDimensionWrites,
      nodeDisposed.nodeWritesAtDisposal,
    );
    assert.equal((await stats()).nodeWritesDuringDelivery, 0);
    assert.deepEqual(errors, []);
    console.log(
      'PASS node measurement updates an ancestor pane outside observer delivery, coalesces the latest size and cancels on unmount',
    );
  } catch (error) {
    failed = true;
    console.error(error);
    console.error(errors);
    console.error(await stats());
  } finally {
    try {
      win.destroy();
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
