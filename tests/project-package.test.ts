import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { readWorkspace } from '../src/main/generation/workspace-database';
import { ProxyService } from '../src/main/media/proxy-service';
import {
  PACKAGE_MAGIC,
  readPackageHeader,
} from '../src/main/packages/package-format';
import { PackageWork } from '../src/main/packages/package-work';
import { ProjectPackageService } from '../src/main/packages/project-package-service';
import {
  readGenerationDraft,
  readProxies,
  withProject,
} from '../src/main/projects/project-database';
import { Library } from '../src/main/storage/library';
import { emptyGenerationDraft } from '../src/shared/generation/draft';
import {
  emptyWorkspace,
  groupMaterials,
  newShot,
} from '../src/shared/generation/workspace';
import type { Asset } from '../src/shared/models';

async function fixture() {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-package-test-')),
  );
  const data = join(base, 'app');
  const root = join(base, '项目 库');
  const library = await Library.open(data, root);
  const packages = new ProjectPackageService(
    library.projects,
    library.store,
    library.gate,
    data,
  );
  const { project } = await library.projects.create('中文 项目');
  return {
    base,
    data,
    root,
    library,
    packages,
    project,
    async dispose() {
      await library.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function addAsset(
  f: Awaited<ReturnType<typeof fixture>>,
  kind: Asset['kind'],
  reference = false,
) {
  const bytes = Buffer.from(`${kind}真实文件回归内容\n`.repeat(100));
  const job = await f.library.acceptResult(
    {
      projectId: f.project.id,
      resultKey: `${kind}-${reference}`,
      name: `素材-${kind}`,
      kind,
      extension: { video: 'mp4', image: 'png', audio: 'wav', text: 'txt' }[
        kind
      ],
      ...(reference ? { usage: 'reference' as const } : {}),
    },
    Readable.from(bytes),
  );
  await f.library.saves.idle();
  return job.id;
}

test('project package round trip preserves real files, clips, independent groups, labels and text overrides; excludes caches and credentials', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const video = await addAsset(f, 'video');
  const image = await addAsset(f, 'image', true);
  const text = await addAsset(f, 'text', true);
  await addAsset(f, 'audio', true);
  const first = await f.library.projects.open(f.project.id);
  const card = first.canvas.cards[0];
  assert.ok(card);
  await f.library.projects.patchCanvas(f.project.id, {
    before: [card],
    after: [
      {
        ...card,
        position: { x: 540, y: -300 },
        trims: { [video]: { start: 1.2, end: 4.8 } },
      },
    ],
  });
  await f.library.projects.update(f.project.id, {
    viewport: { x: 97, y: -50, zoom: 0.6 },
  });
  const shot = newShot('video-shot', '视频镜头', { x: 20, y: 40 }, video);
  shot.nodes.push({
    id: 'caption',
    type: 'asset',
    assetId: text,
    textOverride: '修改仅属于当前卡片',
    position: { x: 400, y: 100 },
    name: '旁白',
    width: 340,
    height: 280,
  });
  shot.labels = [
    {
      id: 'label',
      name: '开头',
      position: { x: 3000, y: 400 },
      color: '#336699',
      pinned: true,
    },
  ];
  const videoShot = groupMaterials(shot, ['caption'], 'video-group');
  const imageShot = newShot('image-shot', '图片镜头', { x: 500, y: 60 });
  imageShot.nodes.push(
    {
      id: 'image',
      type: 'asset',
      assetId: image,
      position: { x: 100, y: 100 },
    },
    {
      id: 'prompt',
      type: 'text',
      text: '傍晚的花园',
      position: { x: 400, y: 100 },
    },
  );
  const groupedImage = groupMaterials(
    imageShot,
    ['image', 'prompt'],
    'image-group',
    undefined,
    { kind: 'image', assets: first.assets },
  );
  const workspace = await f.library.generation.saveWorkspace(f.project.id, {
    ...emptyWorkspace(),
    shots: [videoShot, groupedImage],
  });
  const database = await f.library.projects.databasePath(f.project.id);
  withProject(database, true, (db) =>
    db
      .prepare('INSERT INTO metadata VALUES (?, ?)')
      .run(
        'proxies',
        JSON.stringify([{ relativePath: 'cache/private-proxy.mp4' }]),
      ),
  );
  await writeFile(
    join(dirname(database), 'cache/private-proxy.mp4'),
    'private cache',
  );
  await writeFile(
    join(dirname(database), 'private-user-file.txt'),
    'not part of the project',
  );
  f.library.store.set('provider-api-key', 'application-credential-excluded');
  const expected = await f.library.projects.open(f.project.id);
  const file = join(f.base, '中文 备份.afflatus');
  const info = await f.packages.inspect(f.project.id);
  assert.equal(info.assetCount, 4);
  const exported = await f.packages.export(f.project.id, file);
  assert.equal(exported.path, file);
  assert.ok(exported.bytes > 0);
  const input = await open(file, 'r');
  const { manifest } = await readPackageHeader(input);
  await input.close();
  assert.equal(manifest.entries.length, 5);
  assert.ok(manifest.entries.every((entry) => !entry.path.includes('cache')));
  assert.equal(
    (await readFile(file)).includes(
      Buffer.from('application-credential-excluded'),
    ),
    false,
  );
  const imported = await f.packages.import(file);
  assert.notEqual(imported.project.id, f.project.id);
  assert.equal(imported.project.name, f.project.name);
  assert.deepEqual(imported.canvas, expected.canvas);
  assert.deepEqual(imported.viewport, expected.viewport);
  assert.deepEqual(imported.assets, expected.assets);
  const importedDb = await f.library.projects.databasePath(imported.project.id);
  assert.deepEqual(readWorkspace(importedDb), workspace);
  assert.deepEqual(readProxies(importedDb), []);
  assert.equal(readProxies(database).length, 1);
  for (const asset of imported.assets)
    assert.deepEqual(
      await readFile(join(dirname(importedDb), asset.relativePath)),
      await readFile(join(dirname(database), asset.relativePath)),
    );
  const second = await f.packages.import(file);
  assert.notEqual(second.project.id, imported.project.id);
  assert.equal(second.project.name, imported.project.name);
  await f.library.projects.update(imported.project.id, { name: '独立副本' });
  assert.equal(
    (await f.library.projects.open(f.project.id)).project.name,
    f.project.name,
  );
  assert.equal(
    (await readdir(f.root)).filter((name) =>
      name.startsWith('.afflatus-package-'),
    ).length,
    0,
  );
});

test('legacy drafts keep internal derived IDs and original fields when imported or duplicated', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const image = await addAsset(f, 'image', true);
  const draft = await f.library.generation.save(f.project.id, {
    ...emptyGenerationDraft(),
    prompt: '旧版分镜',
    referenceIds: [image],
  });
  const before = await f.library.generation.readWorkspace(f.project.id);
  const database = await f.library.projects.databasePath(f.project.id);
  const originalBytes = await readFile(database);
  const copy = await f.packages.duplicate(f.project.id, '指定的副本名称');
  const copiedDb = await f.library.projects.databasePath(copy.project.id);
  assert.equal(copy.project.name, '指定的副本名称');
  assert.deepEqual(readWorkspace(copiedDb), before);
  assert.deepEqual(readGenerationDraft(copiedDb), draft);
  assert.deepEqual(await readFile(database), originalBytes);
  const file = join(f.base, '旧版.afflatus');
  await f.packages.export(f.project.id, file);
  const imported = await f.packages.import(file);
  assert.deepEqual(
    readWorkspace(await f.library.projects.databasePath(imported.project.id)),
    before,
  );
});

test('SQLite online backup includes uncheckpointed WAL commits', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const database = await f.library.projects.databasePath(f.project.id);
  const db = new DatabaseSync(database);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  const project = { ...f.project, name: 'WAL 中的新名字' };
  db.prepare("UPDATE metadata SET value = ? WHERE key = 'project'").run(
    JSON.stringify(project),
  );
  try {
    const file = join(f.base, 'wal.afflatus');
    await f.packages.export(f.project.id, file);
    assert.equal((await f.packages.import(file)).project.name, project.name);
  } finally {
    db.close();
  }
});

test('uncommitted staged references block both export preview and package creation, including obsolete legacy draft references', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  // Receive without kicking the save queue: this reproduces a reference accepted by GenerationService before commit.
  const job = await f.library.staging.receive(
    {
      projectId: f.project.id,
      resultKey: 'staged-reference',
      name: '待保存.txt',
      kind: 'text',
      usage: 'reference',
      extension: 'txt',
    },
    Readable.from('still staged'),
  );
  await f.library.generation.save(f.project.id, {
    ...emptyGenerationDraft(),
    prompt: '待保存引用',
    referenceIds: [job.id],
  });
  await f.library.generation.saveWorkspace(f.project.id, emptyWorkspace());
  await assert.rejects(f.packages.inspect(f.project.id), /未保存或缺失/);
  await assert.rejects(
    f.packages.export(f.project.id, join(f.base, 'bad.afflatus')),
    /未保存或缺失/,
  );
  assert.equal(
    (await readdir(f.data)).filter((name) =>
      name.startsWith('.afflatus-package-'),
    ).length,
    0,
  );
  assert.ok((await readFile(f.library.staging.path(job.id))).length);
  f.library.saves.kick();
  await f.library.saves.idle();
  await f.packages.export(f.project.id, join(f.base, 'saved.afflatus'));
});

test('missing, tampered or symlinked managed media never publishes a package or removes user files', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  await addAsset(f, 'video');
  const asset = (await f.library.projects.open(f.project.id)).assets[0];
  assert.ok(asset);
  const media = join(f.root, f.project.folder, asset.relativePath);
  const original = await readFile(media);
  await writeFile(media, Buffer.alloc(original.length, 42));
  await assert.rejects(
    f.packages.export(f.project.id, join(f.base, 'tampered.afflatus')),
    /校验失败/,
  );
  assert.equal(
    (await readdir(f.base)).some(
      (name) => name.endsWith('.part') || name === 'tampered.afflatus',
    ),
    false,
  );
  await rm(media);
  await assert.rejects(
    f.packages.export(f.project.id, join(f.base, 'missing.afflatus')),
    /ENOENT/,
  );
  if (process.platform !== 'win32') {
    const external = join(f.base, 'user-video.mp4');
    await writeFile(external, original);
    await symlink(external, media);
    await assert.rejects(
      f.packages.export(f.project.id, join(f.base, 'symlink.afflatus')),
      /符号链接/,
    );
    assert.deepEqual(await readFile(external), original);
  }
  const protectedFile = join(f.base, 'existing.afflatus');
  await writeFile(protectedFile, 'existing backup');
  await assert.rejects(
    f.packages.export(f.project.id, protectedFile),
    /目标已存在/,
  );
  assert.equal(await readFile(protectedFile, 'utf8'), 'existing backup');
});

test('package work follows migration, rejects while blocked, and remains registered after reopen', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const file = join(f.base, 'backup.afflatus');
  await f.packages.export(f.project.id, file);
  await f.library.gate.block();
  await assert.rejects(f.packages.import(file), /迁移/);
  f.library.gate.release();
  const target = join(f.base, '新库');
  await mkdir(target);
  const preview = await f.library.migration.prepare(target);
  await f.library.migration.start(preview.token);
  await f.library.migration.idle();
  const imported = await f.packages.import(file);
  assert.ok(
    (await f.library.projects.databasePath(imported.project.id)).startsWith(
      target,
    ),
  );
  await f.library.close();
  const reopened = await Library.open(f.data, f.root);
  try {
    assert.equal(
      (await reopened.projects.open(imported.project.id)).project.name,
      f.project.name,
    );
  } finally {
    await reopened.close();
  }
});

test('malformed archives fail before admission and cleanup only their own extracted files', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const good = join(f.base, 'good.afflatus');
  await f.packages.export(f.project.id, good);
  const bytes = await readFile(good);
  const handle = await open(good, 'r');
  const { manifest, start } = await readPackageHeader(handle);
  await handle.close();
  const payload = bytes.subarray(start);
  const pack = (value: unknown, body: Buffer = payload) => {
    const header = Buffer.from(JSON.stringify(value));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    return Buffer.concat([PACKAGE_MAGIC, length, header, body]);
  };
  const entry = manifest.entries[0];
  assert.ok(entry);
  const cases = [
    pack({ ...manifest, version: 999 }),
    pack({ ...manifest, entries: [{ ...entry, path: '../outside.sqlite' }] }),
    pack({ ...manifest, entries: [{ ...entry, path: '/tmp/outside.sqlite' }] }),
    pack({ ...manifest, entries: [{ ...entry, path: 'C:\\outside.sqlite' }] }),
    pack({
      ...manifest,
      entries: [{ ...entry, type: 'symlink', target: '/tmp/outside' }],
    }),
    pack({
      ...manifest,
      entries: [{ ...entry, path: 'assets/videos/CON.mp4' }],
    }),
    pack({ ...manifest, entries: [entry, entry] }),
    pack({ ...manifest, entries: [{ ...entry, size: 1024 ** 5 }] }),
    pack({ ...manifest, entries: [{ ...entry, sha256: '0'.repeat(64) }] }),
    bytes.subarray(0, bytes.length - 1),
    Buffer.concat([bytes, Buffer.from('hidden extra data')]),
  ];
  for (const [index, content] of cases.entries()) {
    const malformed = join(f.base, `malformed-${index}.afflatus`);
    await writeFile(malformed, content);
    await assert.rejects(f.packages.import(malformed));
    assert.equal(f.library.store.projects().length, 1);
    assert.deepEqual(await readdir(f.root), [f.project.folder]);
  }
  // SHA-valid but malicious SQLite must still be rejected before any write can execute its trigger.
  const maliciousDb = join(f.base, 'malicious.sqlite');
  await writeFile(maliciousDb, payload);
  const db = new DatabaseSync(maliciousDb);
  db.exec(
    'CREATE TRIGGER malicious AFTER UPDATE ON metadata BEGIN DELETE FROM assets; END;',
  );
  db.close();
  const malicious = await readFile(maliciousDb);
  const badDatabase = join(f.base, 'malicious-db.afflatus');
  await writeFile(
    badDatabase,
    pack(
      {
        ...manifest,
        entries: [
          {
            ...entry,
            size: malicious.length,
            sha256: createHash('sha256').update(malicious).digest('hex'),
          },
        ],
      },
      malicious,
    ),
  );
  await assert.rejects(f.packages.import(badDatabase), /触发器/);
  assert.deepEqual(await readdir(f.root), [f.project.folder]);
  const mutations: Array<(db: DatabaseSync) => void> = [
    (database) => {
      database.exec(
        'CREATE TRIGGER sqliteXmalicious AFTER INSERT ON metadata BEGIN DELETE FROM assets; END;',
      );
    },
    (database) => {
      database.exec(
        'ALTER TABLE metadata RENAME TO old_metadata; CREATE TABLE metadata (key TEXT, value TEXT NOT NULL); INSERT INTO metadata SELECT * FROM old_metadata; DROP TABLE old_metadata;',
      );
    },
    (database) => {
      database.exec(
        "ALTER TABLE metadata RENAME TO old_metadata; CREATE TABLE metadata (key TEXT, value TEXT NOT NULL); INSERT INTO metadata SELECT * FROM old_metadata; INSERT INTO metadata SELECT * FROM old_metadata WHERE key = 'project'; DROP TABLE old_metadata;",
      );
    },
    (database) => {
      database.exec(
        'ALTER TABLE metadata RENAME TO old_metadata; CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT); INSERT INTO metadata SELECT * FROM old_metadata; DROP TABLE old_metadata;',
      );
    },
    (database) => {
      database.exec(
        'DROP TABLE assets; CREATE TABLE assets (id TEXT PRIMARY KEY, result_key TEXT NOT NULL, payload TEXT NOT NULL);',
      );
    },
    (database) => {
      database.exec(
        'DROP TABLE assets; CREATE TABLE assets (id TEXT PRIMARY KEY, result_key TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(result_key, id));',
      );
    },
    (database) => {
      database.exec('PRAGMA user_version = 999;');
    },
    (database) => {
      database
        .prepare('INSERT INTO metadata VALUES (?, ?)')
        .run('unknown-future-data', '{}');
    },
    (database) => {
      database.prepare('INSERT INTO metadata VALUES (?, ?)').run(
        'generation-workspace',
        JSON.stringify({
          ...emptyWorkspace(),
          shots: [
            newShot(
              'shot',
              '不存在的引用',
              { x: 0, y: 0 },
              '11111111-1111-4111-8111-111111111111',
            ),
          ],
        }),
      );
    },
  ];
  for (const mutate of mutations) {
    await writeFile(maliciousDb, payload);
    const database = new DatabaseSync(maliciousDb);
    mutate(database);
    database.close();
    const body = await readFile(maliciousDb);
    await writeFile(
      badDatabase,
      pack(
        {
          ...manifest,
          entries: [
            {
              ...entry,
              size: body.length,
              sha256: createHash('sha256').update(body).digest('hex'),
            },
          ],
        },
        body,
      ),
    );
    await assert.rejects(f.packages.import(badDatabase));
    assert.deepEqual(await readdir(f.root), [f.project.folder]);
  }
  const undeclared = Buffer.from('not referenced by the database');
  await writeFile(
    badDatabase,
    pack(
      {
        ...manifest,
        entries: [
          entry,
          {
            type: 'file',
            path: 'assets/text/hidden.txt',
            size: undeclared.length,
            sha256: createHash('sha256').update(undeclared).digest('hex'),
          },
        ],
      },
      Buffer.concat([payload, undeclared]),
    ),
  );
  await assert.rejects(f.packages.import(badDatabase), /清单不一致/);
  assert.deepEqual(await readdir(f.root), [f.project.folder]);
});

test('imported and duplicated projects rebuild cache proxies and include all supported media directories', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const assetId = await addAsset(f, 'video');
  const file = join(f.base, 'proxy-source.afflatus');
  await f.packages.export(f.project.id, file);
  const imported = await f.packages.import(file);
  const duplicated = await f.packages.duplicate(f.project.id);
  const proxies = new ProxyService(
    f.library.projects,
    f.library.gate,
    f.library.store,
    f.data,
    async (_source, output) => {
      await writeFile(output, 'derived proxy');
    },
  );
  try {
    for (const project of [imported.project, duplicated.project]) {
      const root = dirname(await f.library.projects.databasePath(project.id));
      for (const directory of [
        'cache',
        'assets/videos',
        'assets/images',
        'assets/audio',
        'assets/text',
      ])
        assert.ok((await lstat(join(root, directory))).isDirectory());
      assert.deepEqual(await proxies.ensure(project.id, assetId), {
        ready: true,
      });
      const proxy = await proxies.file(project.id, assetId);
      assert.ok(proxy);
      assert.equal(await readFile(proxy, 'utf8'), 'derived proxy');
    }
  } finally {
    await proxies.close();
  }
});

test('export refuses project-library and app-data destinations, including aliased parents', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  for (const path of ['', ' ', 'relative.afflatus', join(f.base, 'hidden.txt')])
    await assert.rejects(
      f.packages.export(f.project.id, path),
      /\.afflatus 项目包文件路径/,
    );
  for (const directory of [f.root, f.data, join(f.root, f.project.folder)]) {
    await assert.rejects(
      f.packages.export(f.project.id, join(directory, 'backup.afflatus')),
      /目录之外/,
    );
    assert.equal((await readdir(directory)).includes('backup.afflatus'), false);
  }
  if (process.platform !== 'win32') {
    const alias = join(f.base, 'root-alias');
    await symlink(f.root, alias);
    await assert.rejects(
      f.packages.export(f.project.id, join(alias, 'backup.afflatus')),
      /目录之外/,
    );
  }
});

test('multi-chunk media exports and imports with exact hashes', async (t) => {
  const f = await fixture();
  t.after(() => f.dispose());
  const chunk = Buffer.alloc(64 * 1024, 137);
  async function* content() {
    for (let i = 0; i < 48; i++) yield chunk;
  }
  await f.library.acceptResult(
    {
      projectId: f.project.id,
      resultKey: 'large-stream',
      name: 'stream.mp4',
      kind: 'video',
      extension: 'mp4',
    },
    Readable.from(content()),
  );
  await f.library.saves.idle();
  const file = join(f.base, 'stream.afflatus');
  await f.packages.export(f.project.id, file);
  const imported = await f.packages.import(file);
  const asset = imported.assets[0];
  assert.ok(asset);
  assert.equal(asset.size, 48 * chunk.length);
  const bytes = await readFile(
    join(f.root, imported.project.folder, asset.relativePath),
  );
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
});

test('failed package workspace cleanup preserves unrelated and replaced files', async (t) => {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-package-cleanup-')),
  );
  t.after(() => rm(base, { recursive: true, force: true }));
  const work = await PackageWork.create(base);
  const own = await work.createFile('assets/videos/owned.mp4');
  await own.writeFile('own file');
  await own.close();
  const unrelated = join(work.root, 'assets/videos/user-file.txt');
  await writeFile(unrelated, 'user data');
  await work.cleanup();
  assert.equal(await readFile(unrelated, 'utf8'), 'user data');
  assert.equal(
    (await readdir(dirname(unrelated))).includes('owned.mp4'),
    false,
  );
  if (process.platform !== 'win32') {
    const replaced = await PackageWork.create(base);
    const original = await replaced.createFile('project.sqlite');
    await original.close();
    const file = join(replaced.root, 'project.sqlite');
    await rm(file);
    const external = join(base, 'outside.sqlite');
    await writeFile(external, 'must remain');
    await symlink(external, file);
    await replaced.cleanup();
    assert.equal(await readFile(external, 'utf8'), 'must remain');
  }
});
