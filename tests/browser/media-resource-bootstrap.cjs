// Production main with read-only Chromium media/process instrumentation.
const assert = require('node:assert/strict');
const { appendFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, ipcMain } = require('electron');

const config = JSON.parse(
  readFileSync(process.env.AFFLATUS_MEDIA_RESOURCE_FIXTURE, 'utf8'),
);
assert.equal(
  readFileSync(join(config.scratch, '.fixture-owner'), 'utf8'),
  config.owner,
);
assert.equal(process.env.AFFLATUS_USER_DATA, config.profile);
let logFailed = false;
const append = (kind, value) => {
  try {
    appendFileSync(
      config.nativeLog,
      `${JSON.stringify({ kind, at: Date.now(), value })}\n`,
    );
  } catch (error) {
    if (!logFailed) console.warn('Media diagnostic log unavailable', error);
    logFailed = true;
  }
};
const handle = ipcMain.handle;
let callId = 0;
ipcMain.handle = function (channel, listener) {
  if (!['project:open', 'project:canvas-patch'].includes(channel))
    return handle.call(this, channel, listener);
  return handle.call(this, channel, function (...args) {
    const id = ++callId;
    const start = performance.now();
    append('project-ipc-enter', { channel, id });
    const finish = (result) =>
      append(`project-ipc-${result}`, {
        channel,
        id,
        elapsedMs: performance.now() - start,
      });
    try {
      const result = listener.apply(this, args);
      if (result && typeof result.then === 'function')
        return result.then(
          (value) => {
            finish('resolve');
            return value;
          },
          (error) => {
            finish('reject');
            throw error;
          },
        );
      finish('resolve');
      return result;
    } catch (error) {
      finish('reject');
      throw error;
    }
  });
};
app.on('web-contents-created', (_event, contents) => {
  contents.setBackgroundThrottling(false);
  contents.on('render-process-gone', (_event, details) => {
    append('render-process-gone', { webContentsId: contents.id, ...details });
  });
  contents.on('unresponsive', () => {
    append('web-contents-unresponsive', { webContentsId: contents.id });
  });
  contents.debugger.on('detach', (_event, reason) => {
    append('debugger-detach', { webContentsId: contents.id, reason });
  });
  contents.debugger.attach('1.3');
  contents.debugger.on('message', (_event, method, params) => {
    if (method.startsWith('Media.')) append(method, params);
  });
  void contents.debugger.sendCommand('Media.enable').catch((error) => {
    append('media-observation-error', String(error));
  });
});
let sampleId = 0;
const timer = setInterval(() => {
  if (!app.isReady()) return;
  const id = ++sampleId;
  const start = performance.now();
  append('process-metrics-begin', { id });
  const metrics = app.getAppMetrics();
  append('process-metrics-end', {
    id,
    elapsedMs: performance.now() - start,
  });
  append(
    'process-metrics',
    metrics.map((entry) => ({
      pid: entry.pid,
      type: entry.type,
      name: entry.name,
      cpu: entry.cpu,
      memory: entry.memory,
    })),
  );
}, 500);
timer.unref();
import(pathToFileURL(config.main).href).catch((error) => {
  console.error(error);
  app.exit(1);
});
