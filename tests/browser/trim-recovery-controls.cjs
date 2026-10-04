// Real React editors/queues/guards with typed native fixtures; no media decode claim.
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow, protocol } = require('electron');
const origin = process.env.AFFLATUS_FIXTURE_ORIGIN;
const scratch = process.env.AFFLATUS_FIXTURE_SCRATCH;
const profile = process.env.AFFLATUS_FIXTURE_PROFILE;
if (!origin || !scratch || !profile)
  throw new Error(
    'Run pnpm test:browser trim-recovery-controls with the isolated fixture runner',
  );
const root = resolve(__dirname, '../..');
app.setPath('userData', profile);
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'afflatus-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>裁剪崩溃恢复交互回归</title></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/trim-recovery-controls.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  // The timeline exists for pointer admission checks. Its optional filmstrip is intentionally unavailable.
  protocol.handle(
    'afflatus-media',
    () =>
      new Response(new Uint8Array(), {
        headers: { 'Content-Type': 'video/mp4' },
      }),
  );
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  const run = (source) => win.webContents.executeJavaScript(source);
  const errors = [];
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const wait = async (source, label) => {
    for (let i = 0; i < 200; i++) {
      assert.deepEqual(errors, [], label);
      if (await run(source)) return;
      await sleep(20);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const state = () =>
    run('JSON.parse(document.querySelector("#state").textContent)');
  const stored = () => run('trimRecoveryFixture.state()');
  const load = async () => {
    await win.loadURL(`${origin}/${basename(scratch)}/index.html`);
    await wait('!!document.querySelector("#open")', 'fixture loaded');
    await run('document.querySelector("#open").click()');
    await wait(
      '!!document.querySelector("#state") && JSON.parse(document.querySelector("#state").textContent).loaded',
      'both editor guards loaded',
    );
  };
  let failed = false;
  try {
    await load();
    await run('trimRecoveryFixture.holdNext(); trimRecoveryFixture.save(6)');
    await wait(
      'trimRecoveryFixture.state().pending',
      'A is protected and awaiting its native reply',
    );
    await run('trimRecoveryFixture.save(4)');
    await wait(
      'trimRecoveryFixture.state().records.some(r => r.kind === "trim" && Object.values(r.target.trims ?? {})[0]?.end === 4 && Object.values(r.lastSubmitted?.trims ?? {})[0]?.end === 6)',
      'B is durable without replacing the A receipt',
    );
    await run('trimRecoveryFixture.loseReply()');
    await wait(
      '!!JSON.parse(document.querySelector("#state").textContent).unavailable',
      'lost reply freezes the project',
    );
    await run(
      'trimRecoveryFixture.conflictShot(true); trimRecoveryFixture.retry()',
    );
    await wait(
      'JSON.parse(document.querySelector("#state").textContent).unavailable?.conflict === true',
      'the independent shot guard rejects recovery',
    );
    assert.equal((await state()).canvas.revision, 0);
    assert.equal((await state()).undo, false);
    assert.equal((await state()).queueEnd, 10);
    assert.equal((await stored()).writes, 1);
    console.log(
      'PASS a trim receipt cannot advance the queue or undo history when another live editor rejects recovery',
    );

    await run(
      'trimRecoveryFixture.conflictShot(false); trimRecoveryFixture.retry()',
    );
    await wait(
      '!JSON.parse(document.querySelector("#state").textContent).unavailable && !JSON.parse(document.querySelector("#state").textContent).pending && JSON.parse(document.querySelector("#state").textContent).queueEnd === 4',
      'A is adopted once before B retries from its actual baseline',
    );
    assert.equal((await stored()).writes, 2);
    assert.equal((await state()).canvas.revision, 2);
    await run('document.querySelector("#undo").click()');
    await wait(
      'JSON.parse(document.querySelector("#state").textContent).queueEnd === 6 && !JSON.parse(document.querySelector("#state").textContent).pending',
      'first undo restores A',
    );
    await run('document.querySelector("#undo").click()');
    await wait(
      'JSON.parse(document.querySelector("#state").textContent).queueEnd === 10 && !JSON.parse(document.querySelector("#state").textContent).undo',
      'second undo restores O with no duplicated A step',
    );
    assert.deepEqual((await stored()).records, []);
    console.log(
      'PASS lost A acknowledgement with queued B resumes only B and keeps exactly two working undo steps',
    );

    await load();
    await run('trimRecoveryFixture.save(6)');
    await wait(
      'JSON.parse(document.querySelector("#state").textContent).queueEnd === 6 && !JSON.parse(document.querySelector("#state").textContent).pending',
      'A saved before explicit old-draft recovery',
    );
    await run('trimRecoveryFixture.explicit()');
    await wait(
      'JSON.parse(document.querySelector("#state").textContent).queueEnd === 3',
      'explicit recovery reaches the original editor',
    );
    await run('document.querySelector("#undo").click()');
    await wait(
      'JSON.parse(document.querySelector("#state").textContent).queueEnd === 6 && !JSON.parse(document.querySelector("#state").textContent).pending',
      'one undo reverses exactly the explicit recovery',
    );
    await run('document.querySelector("#undo").click()');
    await wait(
      'JSON.parse(document.querySelector("#state").textContent).queueEnd === 10 && !JSON.parse(document.querySelector("#state").textContent).undo',
      'the previous edit history still works',
    );
    console.log(
      'PASS an explicitly accepted old trim becomes one undo step without destroying existing history',
    );

    await load();
    await run('trimRecoveryFixture.save(6)');
    await wait(
      'JSON.parse(document.querySelector("#state").textContent).queueEnd === 6 && !JSON.parse(document.querySelector("#state").textContent).pending',
      'A saved before explicit recovery loses its reply',
    );
    await run('trimRecoveryFixture.conflictShot(true)');
    assert.equal(await run('trimRecoveryFixture.explicit(true)'), false);
    assert.deepEqual((await stored()).records, []);
    assert.equal((await stored()).remote.canvas.revision, 2);
    assert.equal(await run('trimRecoveryFixture.retry()'), false);
    await wait(
      'JSON.parse(document.querySelector("#state").textContent).unavailable?.conflict === true',
      'a lost explicit recovery reply cannot bypass the independent shot guard',
    );
    assert.equal((await state()).canvas.revision, 1);
    assert.equal((await state()).queueEnd, 6);
    await run('trimRecoveryFixture.conflictShot(false)');
    assert.equal(
      await run('trimRecoveryFixture.retry()'),
      true,
      'the exact committed explicit trim remains recoverable after its native record was acknowledged and the IPC reply was lost',
    );
    await wait(
      '!JSON.parse(document.querySelector("#state").textContent).unavailable && JSON.parse(document.querySelector("#state").textContent).queueEnd === 3',
      'the published verified recovery snapshot settles the explicit trim',
    );
    await run('document.querySelector("#undo").click()');
    await wait(
      'JSON.parse(document.querySelector("#state").textContent).queueEnd === 6 && !JSON.parse(document.querySelector("#state").textContent).pending',
      'one undo reverses the recovered trim exactly once after a lost reply',
    );
    await run('document.querySelector("#undo").click()');
    await wait(
      'JSON.parse(document.querySelector("#state").textContent).queueEnd === 10 && !JSON.parse(document.querySelector("#state").textContent).undo',
      'lost explicit recovery preserves the earlier undo step without duplication',
    );
    assert.deepEqual((await stored()).records, []);
    console.log(
      'PASS explicit recovery with a lost native reply reuses strict guards and contributes exactly one undo step',
    );

    await load();
    assert.equal(await run('trimRecoveryFixture.explicit("before")'), false);
    assert.equal((await stored()).remote.canvas.revision, 0);
    assert.equal((await stored()).records.length, 1);
    assert.equal((await state()).canRecover, false);
    assert.equal(await run('trimRecoveryFixture.retry()'), true);
    await wait(
      'JSON.parse(document.querySelector("#state").textContent).canRecover === true',
      'an unchanged verified baseline releases the explicit recovery attempt',
    );
    assert.equal((await state()).undo, false);
    assert.equal(await run('trimRecoveryFixture.explicit()'), true);
    await wait(
      'JSON.parse(document.querySelector("#state").textContent).queueEnd === 3',
      'the original retained record can be explicitly retried',
    );
    assert.equal((await stored()).remote.canvas.revision, 1);
    assert.deepEqual((await stored()).records, []);
    console.log(
      'PASS an explicit recovery rejected before its write can retry the retained record after verifying the original project',
    );

    await load();
    await run('trimRecoveryFixture.save(6)');
    await wait(
      'JSON.parse(document.querySelector("#state").textContent).queueEnd === 6 && !JSON.parse(document.querySelector("#state").textContent).pending',
      'A saved before an already-applied old record is acknowledged',
    );
    assert.equal(await run('trimRecoveryFixture.explicit("noop")'), false);
    assert.equal((await stored()).remote.canvas.revision, 1);
    assert.deepEqual((await stored()).records, []);
    assert.equal(await run('trimRecoveryFixture.retry()'), true);
    await wait(
      'JSON.parse(document.querySelector("#state").textContent).canRecover === true',
      'a native no-op acknowledgement releases the uncertain receipt',
    );
    await run('document.querySelector("#undo").click()');
    await wait(
      'JSON.parse(document.querySelector("#state").textContent).queueEnd === 10 && !JSON.parse(document.querySelector("#state").textContent).undo',
      'the already-applied record must not introduce a phantom undo step',
    );
    assert.equal((await stored()).remote.canvas.revision, 2);
    console.log(
      'PASS a lost reply for an already-applied native recovery does not increment revision or add an undo step',
    );

    await load();
    const lock = await run('trimRecoveryFixture.lockGestureTest()');
    assert.equal(lock.rejected, true);
    assert.equal(lock.gestures, 0);
    await run(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    );
    assert.equal((await state()).gesturing, false);
    assert.equal((await stored()).writes, 0);
    assert.deepEqual((await stored()).records, []);
    console.log(
      'PASS active gestures block recovery and same-tick recovery locks reject both new trims and real timeline pointer capture',
    );
    assert.deepEqual(errors, []);
  } catch (error) {
    failed = true;
    console.error(error);
    console.error(errors);
    console.error(
      await run('document.body.innerText').catch(() => 'Renderer unavailable'),
    );
  } finally {
    win.destroy();
    app.exit(failed ? 1 : 0);
  }
});
