// Pure Node helpers shared by isolated real-process desktop checks.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const {
  appendFileSync,
  createReadStream,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

async function hash(path) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}

async function withFixture(prefix, operation) {
  assert.match(prefix, /^afflatus-[a-z-]+$/);
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const identity = lstatSync(base);
  const owner = randomUUID();
  const marker = join(base, '.fixture-owner');
  const log = join(tmpdir(), `${prefix}${owner}.log`);
  writeFileSync(marker, owner, { flag: 'wx' });
  writeFileSync(log, '', { flag: 'wx' });
  let passed = false;
  try {
    await operation(base, log);
    passed = true;
  } finally {
    const current = lstatSync(base);
    assert.ok(
      !current.isSymbolicLink() &&
        current.dev === identity.dev &&
        current.ino === identity.ino &&
        readFileSync(marker, 'utf8') === owner,
      'Refusing to clean a replaced fixture directory',
    );
    rmSync(base, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 250,
    });
    if (passed) rmSync(log);
    else console.error(`Desktop fixture failure log retained: ${log}`);
  }
}

async function runElectron(
  electron,
  script,
  base,
  args,
  log,
  environment = {},
) {
  const env = {
    ...process.env,
    ...environment,
    AFFLATUS_USER_DATA: join(base, 'profile'),
    AFFLATUS_PROJECTS_DIR: join(base, 'projects'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [script, ...args, `--scratch=${base}`], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    for (const [stream, target] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ])
      stream.on('data', (bytes) => {
        appendFileSync(log, bytes);
        target.write(bytes);
      });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 90000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve();
      else
        reject(
          new Error(
            `${args.join(' ')} exited ${signal ?? code}${timedOut ? ' after timeout' : ''}`,
          ),
        );
    });
  });
}

module.exports = { hash, withFixture, runElectron };
