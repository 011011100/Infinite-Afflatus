// Production main with read-only Chromium media/process instrumentation.
const assert = require('node:assert/strict');
const { appendFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');

const config = JSON.parse(
  readFileSync(process.env.AFFLATUS_MEDIA_RESOURCE_FIXTURE, 'utf8'),
);
assert.equal(
  readFileSync(join(config.scratch, '.fixture-owner'), 'utf8'),
  config.owner,
);
assert.equal(process.env.AFFLATUS_USER_DATA, config.profile);
const append = (kind, value) =>
  appendFileSync(
    config.nativeLog,
    `${JSON.stringify({ kind, at: Date.now(), value })}\n`,
  );
app.on('web-contents-created', (_event, contents) => {
  contents.setBackgroundThrottling(false);
  contents.debugger.attach('1.3');
  contents.debugger.on('message', (_event, method, params) => {
    if (method.startsWith('Media.')) append(method, params);
  });
  void contents.debugger.sendCommand('Media.enable').catch((error) => {
    append('media-observation-error', String(error));
  });
});
const timer = setInterval(() => {
  if (!app.isReady()) return;
  append(
    'process-metrics',
    app.getAppMetrics().map((entry) => ({
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
