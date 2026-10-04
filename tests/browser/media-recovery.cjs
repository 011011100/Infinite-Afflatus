// Synthetic real-media renderer regression. Reuses Vite and never opens the user's library.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, basename } = require('node:path');
const { app, BrowserWindow, protocol } = require('electron');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'afflatus-media',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);
const root = resolve(__dirname, '../..');
const scratch = mkdtempSync(join(root, 'src/renderer/.media-recovery-test-'));
const media = mkdtempSync(join(tmpdir(), 'afflatus-media-recovery-'));
const cleanup = () => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(media, { recursive: true, force: true });
};
app.once('will-quit', cleanup);
writeFileSync(
  join(scratch, 'index.html'),
  `<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div><script type="module" src="/@fs/${root}/tests/browser/media-recovery.fixture.tsx"></script></body></html>`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  let win;
  let timer;
  let failed = false;
  const errors = [];
  try {
    const file = join(media, 'synthetic.mp4');
    const encoded = spawnSync(
      process.env.FFMPEG_PATH || 'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=160x90:r=20:d=5',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=5',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        file,
      ],
      { timeout: 30_000, windowsHide: true },
    );
    assert.equal(encoded.status, 0, encoded.stderr?.toString());
    const bytes = readFileSync(file);
    const requests = [];
    protocol.handle('afflatus-media', (request) => {
      requests.push(request.url);
      const range = request.headers.get('range')?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2]
        ? Math.min(Number(range[2]), bytes.length - 1)
        : bytes.length - 1;
      if (start >= bytes.length)
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${bytes.length}` },
        });
      return new Response(bytes.subarray(start, end + 1), {
        status: range ? 206 : 200,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
          ...(range
            ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` }
            : {}),
        },
      });
    });
    win = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      webPreferences: { backgroundThrottling: false },
    });
    const wc = win.webContents;
    wc.on('console-message', (details) => {
      if (details.level === 'error') errors.push(details.message);
    });
    const run = (code) => wc.executeJavaScript(code);
    const state = () =>
      run('JSON.parse(document.querySelector("#state").textContent)');
    const click = (id) =>
      run(`document.getElementById(${JSON.stringify(id)}).click()`);
    const until = async (predicate, label) => {
      for (let i = 0; i < 150; i++) {
        if (await predicate()) return;
        await sleep(50);
      }
      throw new Error(`Timed out: ${label}; ${JSON.stringify(await state())}`);
    };
    let painting = false;
    timer = setInterval(async () => {
      if (painting || wc.isDestroyed()) return;
      painting = true;
      try {
        await wc.capturePage();
      } catch {
      } finally {
        painting = false;
      }
    }, 32);
    await win.loadURL(
      `${process.env.AFFLATUS_TEST_URL || 'http://127.0.0.1:5173'}/${basename(scratch)}/index.html`,
    );
    await until(
      () => run('!!document.querySelector("#state")'),
      'fixture mount',
    );
    await until(async () => {
      const value = await state();
      return (
        value.loaded && value.playback.pending === null && !value.playback.error
      );
    }, 'real media ready');
    await until(
      async () => !!(await state()).health.report,
      'StrictMode automatic inspection',
    );
    const health = (await state()).health;
    assert.equal(health.report.projectId, 'media-recovery');
    assert.equal(health.report.mode, 'quick');
    assert.equal(health.scanCalls, 1);
    assert.equal(health.cancelCalls, 0);
    assert.equal(health.busy, false);
    console.log(
      'PASS StrictMode effect replay completes one automatic health scan and exposes its report',
    );
    await click('second-paused-muted');
    await until(async () => {
      const { playback } = await state();
      return (
        playback.index === 1 &&
        playback.pending === null &&
        !playback.playing &&
        Math.abs(playback.time - 2) < 0.15
      );
    }, 'second clip seek');
    const activeMedia = () =>
      run(`(() => {
      const video = [...document.querySelectorAll('video')].find(el => el.style.opacity === '1' && el.style.visibility === 'visible');
      return video && { src: video.src, time: video.currentTime, paused: video.paused, muted: video.muted };
    })()`);
    const before = await state();
    assert.equal((await activeMedia()).muted, true);
    await click('restore-unrelated');
    await sleep(350);
    const unrelated = await state();
    assert.deepEqual(
      unrelated.playback,
      before.playback,
      'unrelated repair must not recreate or restart the player',
    );
    assert.equal((await activeMedia()).muted, true);
    console.log(
      'PASS unrelated asset restoration preserves second clip, paused position and mute without decoding again',
    );

    await click('restore-current');
    await until(async () => {
      const { playback } = await state();
      const video = await activeMedia();
      return (
        playback.pending === null &&
        playback.loads > before.playback.loads &&
        video?.src.includes('second-clip?revision=1')
      );
    }, 'repaired source reloaded');
    const restored = await state();
    const video = await activeMedia();
    assert.equal(restored.playback.index, 1);
    assert.equal(restored.playback.playing, false);
    assert.equal(restored.playback.error, null);
    assert.ok(Math.abs(restored.playback.time - 2) < 0.15);
    assert.ok(Math.abs(video.time - 2) < 0.15);
    assert.equal(video.paused, true);
    assert.equal(video.muted, true);
    assert.ok(requests.some((url) => url.includes('second-clip?revision=1')));
    console.log(
      'PASS same-ID/hash video restoration reloads the source and retains position, pause and mute',
    );

    await until(
      () =>
        run(
          'document.querySelector("[data-text-node=source-node] textarea")?.disabled === true && document.querySelectorAll("[role=alert]").length === 2',
        ),
      'missing text source',
    );
    await run(
      'document.querySelector("[data-text-node=draft-node] textarea").focus(); document.querySelector("[data-text-node=draft-node] textarea").select();',
    );
    await wc.insertText('修复期间继续编辑的独立草稿');
    await until(async () => (await state()).canUndo, 'draft history');
    const draftBefore = await state();
    await click('restore-text');
    await until(
      () =>
        run(
          'document.querySelector("[data-text-node=source-node] textarea")?.value === "恢复后的原文本" && document.querySelectorAll("[role=alert]").length === 0',
        ),
      'text source recovery',
    );
    assert.equal(
      await run(
        'document.querySelector("[data-text-node=source-node] textarea").disabled',
      ),
      false,
    );
    assert.equal(
      await run(
        'document.querySelector("[data-text-node=draft-node] textarea").value',
      ),
      '修复期间继续编辑的独立草稿',
    );
    assert.deepEqual((await state()).nodes, draftBefore.nodes);
    assert.equal((await state()).canUndo, true);
    await click('undo');
    await until(
      () =>
        run(
          'document.querySelector("[data-text-node=draft-node] textarea").value === "原有独立草稿"',
        ),
      'undo retained draft',
    );
    await click('redo');
    await until(
      () =>
        run(
          'document.querySelector("[data-text-node=draft-node] textarea").value === "修复期间继续编辑的独立草稿"',
        ),
      'redo retained draft',
    );
    await sleep(450);
    assert.equal((await state()).saveError, null);
    assert.deepEqual(errors, []);
    console.log(
      'PASS restored text becomes editable automatically while overrides and shot undo/redo survive',
    );
  } catch (error) {
    failed = true;
    console.error(error);
    console.error('Renderer errors:', errors);
  } finally {
    clearInterval(timer);
    win?.destroy();
    cleanup();
    app.exit(failed ? 1 : 0);
  }
});
