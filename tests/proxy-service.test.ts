import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { ProxyService } from '../src/main/media/proxy-service';
import { readProxies } from '../src/main/projects/project-database';
import { Library } from '../src/main/storage/library';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(
  encode: (input: string, output: string, signal: AbortSignal) => Promise<void>,
) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-proxy-test-')),
  );
  const data = join(base, 'app');
  const library = await Library.open(data, join(base, 'projects'));
  const proxies = new ProxyService(
    library.projects,
    library.gate,
    library.store,
    data,
    encode,
  );
  const { project } = await library.projects.create('预览验证');
  await library.acceptResult(
    {
      projectId: project.id,
      resultKey: 'input',
      name: 'source.mp4',
      kind: 'video',
      extension: 'mp4',
    },
    Readable.from('original source'),
  );
  await library.saves.idle();
  const asset = (await library.projects.open(project.id)).assets[0];
  assert.ok(asset);
  return {
    base,
    data,
    library,
    proxies,
    project,
    asset,
    async dispose() {
      await proxies.close();
      await library.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

test('proxy generation is deduplicated, reusable and migrated as registered derived media', async () => {
  let encodes = 0;
  const f = await fixture(async (input, output) => {
    encodes++;
    assert.equal(await readFile(input, 'utf8'), 'original source');
    await writeFile(output, 'proxy bytes');
  });
  try {
    assert.deepEqual(
      await Promise.all([
        f.proxies.ensure(f.project.id, f.asset.id),
        f.proxies.ensure(f.project.id, f.asset.id),
      ]),
      [{ ready: true }, { ready: true }],
    );
    await f.proxies.ensure(f.project.id, f.asset.id);
    assert.equal(encodes, 1);
    const before = await f.proxies.file(f.project.id, f.asset.id);
    assert.ok(before);
    const userFile = join(dirname(before), 'personal.mp4');
    await writeFile(userFile, 'do not delete');
    const target = join(f.base, 'moved');
    await mkdir(target);
    const preview = await f.library.migration.prepare(target);
    await f.library.migration.start(preview.token);
    await f.library.migration.idle();
    const after = await f.proxies.file(f.project.id, f.asset.id);
    assert.ok(after);
    assert.ok(after.startsWith(target));
    assert.equal(await readFile(after, 'utf8'), 'proxy bytes');
    await assert.rejects(readFile(before), { code: 'ENOENT' });
    assert.equal(await readFile(userFile, 'utf8'), 'do not delete');
    await f.proxies.ensure(f.project.id, f.asset.id);
    assert.equal(encodes, 1);
    assert.deepEqual(await readdir(join(f.data, 'preview-work')), []);
  } finally {
    await f.dispose();
  }
});

test('a running transcode does not block migration and publishes only at the new location', async () => {
  let started!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const f = await fixture(async (input, output) => {
    started();
    await released;
    assert.equal(await readFile(input, 'utf8'), 'original source');
    await writeFile(output, 'proxy bytes');
  });
  try {
    const pending = f.proxies.ensure(f.project.id, f.asset.id);
    await entered;
    const oldRoot = f.library.store.root;
    const target = join(f.base, 'moved');
    await mkdir(target);
    const preview = await f.library.migration.prepare(target);
    await f.library.migration.start(preview.token);
    finish();
    await f.library.migration.idle();
    assert.deepEqual(await pending, { ready: true });
    assert.ok(
      (await f.proxies.file(f.project.id, f.asset.id))?.startsWith(target),
    );
    assert.deepEqual(await readdir(oldRoot), []);
    assert.equal(
      readProxies(await f.library.projects.databasePath(f.project.id)).length,
      1,
    );
  } finally {
    finish();
    await f.dispose();
  }
});

test('shutdown cancels encoding, leaves originals unchanged and cleans only registered work files', async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture(async (_input, output, signal) => {
    await writeFile(output, 'partial');
    started();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });
  });
  try {
    const pending = f.proxies.ensure(f.project.id, f.asset.id);
    await entered;
    const unknown = join(f.data, 'preview-work', 'user.txt');
    await writeFile(unknown, 'keep');
    await f.proxies.close();
    assert.deepEqual(await pending, { ready: false });
    assert.deepEqual(await readdir(join(f.data, 'preview-work')), ['user.txt']);
    assert.equal(await f.proxies.file(f.project.id, f.asset.id), null);
    assert.equal(
      (await f.library.projects.open(f.project.id)).assets[0]?.sha256,
      f.asset.sha256,
    );
  } finally {
    await f.dispose();
  }
});

test('missing cache rebuilds without blocking migration; unknown cache files remain untouched', async () => {
  const f = await fixture(async (_input, output) => {
    await writeFile(output, 'proxy');
  });
  try {
    await f.proxies.ensure(f.project.id, f.asset.id);
    const file = await f.proxies.file(f.project.id, f.asset.id);
    assert.ok(file);
    await rm(file);
    const target = join(f.base, 'moved');
    await mkdir(target);
    const preview = await f.library.migration.prepare(target);
    await f.library.migration.start(preview.token);
    await f.library.migration.idle();
    assert.equal(f.library.store.root, target);
    assert.deepEqual(await f.proxies.ensure(f.project.id, f.asset.id), {
      ready: true,
    });
    await flush();
    assert.ok(await f.proxies.file(f.project.id, f.asset.id));
  } finally {
    await f.dispose();
  }
});
