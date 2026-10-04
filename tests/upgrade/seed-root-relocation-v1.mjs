// Fixture orchestration only. Both data and relocation business writers are
// imported from their separate fixed Git archives, never from current src/.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const [source, dataSource, data, writerCommit, dataCommit, mode] =
  process.argv.slice(2);
assert.ok(source && dataSource && data);
assert.equal(writerCommit, '025586b295817ceeed8714b6c317678ed6a3b924');
assert.equal(dataCommit, '0550d2cbe736daf7443e8570a18c57a6aec1b4bd');
assert.ok(['archived-original', 'published-old-anchor'].includes(mode));
const seeded = await promisify(execFile)(
  process.execPath,
  [
    '--import',
    import.meta.resolve('tsx'),
    fileURLToPath(new URL('./seed-root-relocation.mjs', import.meta.url)),
    dataSource,
    data,
    dataCommit,
  ],
  { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
);
assert.match(seeded.stdout, /PASS archived Library/);
const state = JSON.parse(
  await fs.readFile(join(data, 'root-relocation-history.json'), 'utf8'),
);
assert.equal(state.writerCommit, dataCommit);
const { RootRelocationService } = await import(
  pathToFileURL(join(source, 'src/main/relocation/root-relocation-service.ts'))
    .href
);
const hash = async (file) =>
  createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
const appFile = join(state.app, 'app.sqlite');
const originalDatabaseHash = await hash(appFile);
const db = new DatabaseSync(appFile, { readOnly: true });
let originalRows;
try {
  db.exec('PRAGMA busy_timeout=5000');
  originalRows = Object.fromEntries(
    ['settings', 'projects', 'saves'].map((table) => [
      table,
      db
        .prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`)
        .all()
        .map((row) => ({ ...row })),
    ]),
  );
} finally {
  db.close();
}
const anchorFile = join(state.app, 'app-backup-anchor.json');
const oldAnchorHash = await hash(anchorFile);
// Simulate the user's original-directory rename and a missing registered asset.
// Neither action synthesizes a migration journal or a relocation intent.
await fs.unlink(join(state.root, state.savedMediaRelative));
const newRoot = join(data, '真实旧版本重定位 中文');
const previousDirectory = await fs.lstat(state.root, { bigint: true });
await fs.rename(state.root, newRoot);
const currentDirectory = await fs.lstat(newRoot, { bigint: true });
for (const key of ['dev', 'ino', 'birthtimeNs'])
  assert.equal(currentDirectory[key], previousDirectory[key]);
const service = new RootRelocationService(state.app);
const preview = await service.preview(newRoot);
assert.equal(preview.pendingSaveCount, 1);
const link = fs.link;
const rename = fs.rename;
let hits = 0;
const interrupt = () => {
  hits++;
  throw Object.assign(new Error(`Historical relocation interruption ${mode}`), {
    code: 'EIO',
  });
};
fs.link = async (...args) => {
  if (mode === 'archived-original' && String(args[1]) === appFile) interrupt();
  return link(...args);
};
fs.rename = async (...args) => {
  if (mode === 'published-old-anchor' && String(args[1]) === anchorFile)
    interrupt();
  return rename(...args);
};
syncBuiltinESMExports();
try {
  await assert.rejects(
    service.confirm(preview.token),
    /Historical relocation interruption/,
  );
} finally {
  fs.link = link;
  fs.rename = rename;
  syncBuiltinESMExports();
  await service.close();
}
assert.equal(
  hits,
  1,
  'Fault must hit the actual archived publication boundary once',
);
const intentFile = join(state.app, 'app-root-relocation.json');
const intent = JSON.parse(await fs.readFile(intentFile, 'utf8'));
assert.equal(intent.format, 'infinite-afflatus-root-relocation');
assert.equal(intent.version, 1);
assert.deepEqual(intent.anchor, state.anchor);
assert.equal(intent.resultAnchor.root.path, newRoot);
assert.notEqual(intent.resultAnchor.generation, state.anchor.generation);
assert.equal(
  await hash(anchorFile),
  oldAnchorHash,
  'Both cases must retain the old independent anchor',
);
assert.equal(
  await hash(join(intent.retained.path, 'app.sqlite')),
  originalDatabaseHash,
);
const candidate = join(intent.retained.path, 'new-app.sqlite');
assert.equal(await hash(candidate), intent.candidate.sha256);
if (mode === 'archived-original')
  await assert.rejects(fs.lstat(appFile), { code: 'ENOENT' });
else {
  assert.equal(await hash(appFile), intent.candidate.sha256);
  const a = await fs.lstat(appFile, { bigint: true });
  const b = await fs.lstat(candidate, { bigint: true });
  for (const key of ['dev', 'ino', 'birthtimeNs'])
    assert.equal(
      a[key],
      b[key],
      'Old public service must really publish the candidate inode',
    );
}
const contract = {
  state,
  data,
  newRoot,
  damagedDraft: null,
  generation: intent.resultAnchor.generation,
  retainedDirectory: intent.retained.path,
  originalDatabaseHash,
};
await fs.writeFile(
  join(data, 'root-relocation-v1-history.json'),
  JSON.stringify(
    {
      writerCommit,
      dataCommit,
      mode,
      formatVersion: 1,
      contract,
      originalRows,
      intent,
      intentFile,
      oldAnchorHash,
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
console.log(
  `PASS archived v1 RootRelocationService ${writerCommit}: real ${mode} intent and complete candidate retained`,
);
