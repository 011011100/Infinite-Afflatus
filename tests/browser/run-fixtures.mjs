// An isolated renderer server and disposable Electron profiles; never attach to a user's dev app.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import config from '../../electron.vite.config.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const available = [
  'xyflow-lifecycle',
  'canvas-recovery',
  'media-tool-settings-controls',
  'reference-import-controls',
  'staging-cleanup-controls',
  'project-rename-controls',
  'trim-recovery-controls',
  'project-edit-recovery-controls',
  'app-backup-controls',
];
const requested = process.argv.slice(2);
const scenarios = requested.length ? requested : available;
for (const scenario of scenarios) {
  if (!available.includes(scenario))
    throw new Error(`Unknown renderer fixture: ${scenario}`);
}
const require = createRequire(import.meta.url);
const electron = require('electron');
if (typeof electron !== 'string') throw new Error('Run this harness with Node');
const cache = await mkdtemp(join(tmpdir(), 'afflatus-renderer-fixtures-'));
let server;
const sockets = new Set();
const http = createHttpServer((request, response) => {
  if (server) server.middlewares(request, response);
  else {
    response.statusCode = 503;
    response.end('Renderer fixture server is starting');
  }
});
http.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
const closeHttp = async () => {
  const closed = new Promise((resolve, reject) => {
    http.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    });
  });
  // Includes upgraded sockets, unlike closeAllConnections. Every socket here
  // belongs to this runner's loopback listener and its disposable Electron apps.
  for (const socket of sockets) socket.destroy();
  await closed;
};
let child;
let childClosed;
const scratchDirectories = new Set();
const failures = [];
const stopped = new AbortController();
const interrupt = (signal) => {
  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  stopped.abort(new Error(`Renderer fixtures interrupted by ${signal}`));
  child?.kill('SIGKILL');
};
const onInterrupt = () => interrupt('SIGINT');
const onTerminate = () => interrupt('SIGTERM');
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
const remove = (path) =>
  rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
try {
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });
  stopped.signal.throwIfAborted();
  const address = http.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture server did not bind a TCP port');
  server = await createServer({
    ...config.renderer,
    configFile: false,
    root: join(root, 'src/renderer'),
    cacheDir: join(cache, 'node_modules/.vite'),
    optimizeDeps: {
      ...config.renderer.optimizeDeps,
      entries: scenarios.map((name) =>
        join(root, 'tests/browser', `${name}.fixture.tsx`),
      ),
    },
    server: {
      host: '127.0.0.1',
      port: address.port,
      // Standalone Vite registers a SIGTERM handler that calls process.exit
      // before our Electron and directory cleanup finishes. Own the HTTP/HMR
      // listener instead, so the runner alone controls termination.
      middlewareMode: true,
      hmr: { server: http, clientPort: address.port },
      fs: { allow: [root] },
    },
  });
  stopped.signal.throwIfAborted();
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.AFFLATUS_FIXTURE_ORIGIN = `http://127.0.0.1:${address.port}`;
  for (const scenario of scenarios) {
    stopped.signal.throwIfAborted();
    const scratch = await mkdtemp(join(root, 'src/renderer', `.${scenario}-`));
    scratchDirectories.add(scratch);
    const profile = await mkdtemp(join(cache, `${scenario}-profile-`));
    env.AFFLATUS_FIXTURE_SCRATCH = scratch;
    env.AFFLATUS_FIXTURE_PROFILE = profile;
    stopped.signal.throwIfAborted();
    console.log(`Running renderer fixture: ${scenario}`);
    await new Promise((resolve, reject) => {
      const running = spawn(
        electron,
        [join(root, 'tests/browser', `${scenario}.cjs`)],
        {
          cwd: root,
          env,
          stdio: 'inherit',
        },
      );
      child = running;
      childClosed = new Promise((done) => running.once('close', done));
      let startupError;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        running.kill('SIGKILL');
      }, 120_000);
      running.once('error', (error) => {
        startupError = error;
      });
      running.once('close', (code, signal) => {
        clearTimeout(timeout);
        child = null;
        if (startupError) reject(startupError);
        else if (stopped.signal.aborted) reject(stopped.signal.reason);
        else if (code === 0 && !timedOut) resolve();
        else
          reject(
            new Error(
              `${scenario} ${timedOut ? 'timed out' : `failed (${code ?? signal})`}`,
            ),
          );
      });
    });
    // Windows session files may remain locked until Electron has actually exited.
    await remove(profile);
    await remove(scratch);
    scratchDirectories.delete(scratch);
  }
} catch (error) {
  failures.push(error);
} finally {
  child?.kill('SIGKILL');
  await childClosed;
  try {
    const closed = await Promise.allSettled([server?.close(), closeHttp()]);
    for (const result of closed)
      if (result.status === 'rejected') failures.push(result.reason);
  } finally {
    const cleaned = await Promise.allSettled([
      ...[...scratchDirectories].map(remove),
      remove(cache),
    ]);
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
    for (const result of cleaned)
      if (result.status === 'rejected') failures.push(result.reason);
  }
}
if (failures.length === 1) throw failures[0];
if (failures.length)
  throw new AggregateError(
    failures,
    'Renderer fixture execution or cleanup failed',
  );
