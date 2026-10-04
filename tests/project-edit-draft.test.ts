import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs, {
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { MAX_DRAFT_STORAGE_BYTES } from '../src/main/drafts/draft-validation';
import { ProjectEditDraftService } from '../src/main/drafts/project-edit-draft-service';
import {
  recordAsset,
  withProject,
} from '../src/main/projects/project-database';
import { ProjectService } from '../src/main/projects/project-service';
import { AppStore } from '../src/main/storage/app-store';
import { requireCleanProfile } from '../src/main/storage/startup-checks';
import { WriteGate } from '../src/main/storage/write-gate';
import type { Asset } from '../src/shared/models';
import type {
  NameEditDraftInput,
  ProjectEditDraftInput,
  TrimEditDraftInput,
} from '../src/shared/project-edit-draft';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-project-edit-')),
  );
  const data = join(base, 'app');
  const root = join(base, 'projects');
  await mkdir(data);
  await mkdir(root);
  const store = new AppStore(join(data, 'app.sqlite'), root);
  const gate = new WriteGate();
  const projects = new ProjectService(store, gate);
  const project = (await projects.create('原项目')).project;
  const database = await projects.databasePath(project.id);
  const sources: { path: string; bytes: Buffer }[] = [];
  for (let i = 0; i < 2; i++) {
    const id = randomUUID();
    const bytes = Buffer.from(`synthetic immutable source ${i}`);
    const asset: Asset = {
      id,
      name: `视频 ${i}.mp4`,
      relativePath: `assets/videos/${id}.mp4`,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      kind: 'video',
    };
    const path = join(root, project.id, asset.relativePath);
    await writeFile(path, bytes);
    sources.push({ path, bytes });
    store.putProject(recordAsset(database, `fixture:${i}`, asset, project));
  }
  const snapshot = await projects.open(project.id);
  const services: ProjectEditDraftService[] = [];
  const service = () => {
    const next = new ProjectEditDraftService(data);
    services.push(next);
    return next;
  };
  const drafts = service();
  const file = (session = 'name') =>
    join(data, 'project-edit-drafts', `${project.id}.${session}.json`);
  const name = (
    target = '新项目',
    seq = 1,
    sessionId = 'name',
  ): NameEditDraftInput => ({
    kind: 'name',
    sessionId,
    seq,
    baseline: project.name,
    target,
  });
  const trim = (seq = 1, end = 2): TrimEditDraftInput => {
    const baseline = structuredClone(snapshot.canvas.cards[0]);
    assert.ok(baseline);
    const assetId = baseline.assetIds[0];
    assert.ok(assetId);
    return {
      kind: 'trim',
      sessionId: 'trim',
      seq,
      baseline,
      target: {
        ...structuredClone(baseline),
        trims: { [assetId]: { start: 0.2, end } },
      },
      assets: baseline.assetIds.map((id) => {
        const asset = snapshot.assets.find((item) => item.id === id);
        assert.ok(asset);
        return structuredClone(asset);
      }),
    };
  };
  const recover = (input: ProjectEditDraftInput, current = drafts) =>
    current.recover(project, input, (record, verify) =>
      projects.restoreProjectEdit(project.id, record, verify),
    );
  t.after(async () => {
    for (const current of services) await current.close();
    for (const source of sources)
      assert.deepEqual(await readFile(source.path), source.bytes);
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  return {
    base,
    data,
    root,
    store,
    gate,
    projects,
    project,
    database,
    snapshot,
    drafts,
    service,
    file,
    name,
    trim,
    recover,
  };
}

test('raw empty name input survives an unavailable project and restart; only explicit valid save writes it', async (t) => {
  const f = await fixture(t);
  const input = f.name('   ');
  await rename(f.database, `${f.database}.offline`);
  await f.drafts.protect(f.project, input);
  await f.drafts.close();
  const reopened = f.service();
  assert.equal((await reopened.get(f.project.id, input)).target, '   ');
  await rename(`${f.database}.offline`, f.database);
  const before = await readFile(f.database);
  await assert.rejects(f.recover(input, reopened), /名称需要/);
  assert.deepEqual(await readFile(f.database), before);
  const valid = f.name('  新项目  ', 2);
  await reopened.protect(f.project, valid);
  const saved = await f.recover(valid, reopened);
  assert.equal(saved.project.name, '新项目');
  assert.deepEqual(saved.canvas, f.snapshot.canvas);
  assert.deepEqual((await reopened.list(f.project.id)).drafts, []);
  const lostDatabase = join(f.base, 'missing-app');
  await mkdir(lostDatabase);
  await mkdir(join(lostDatabase, 'project-edit-drafts'));
  await writeFile(
    join(lostDatabase, 'project-edit-drafts', 'keep.json'),
    'recovery evidence',
  );
  await assert.rejects(
    requireCleanProfile(lostDatabase, join(f.base, 'unused-root')),
    /app.sqlite/,
  );
});

test('sequence, stream identity, late acknowledgement and explicit discard preserve newer input', async (t) => {
  const f = await fixture(t);
  const a = f.name('A');
  const b = f.name('B', 2);
  await f.drafts.protect(f.project, a);
  await assert.rejects(
    f.drafts.protect(f.project, f.name('other')),
    /相同草稿顺序/,
  );
  await f.drafts.protect(f.project, b);
  assert.equal(await f.drafts.protect(f.project, a), 2);
  assert.equal(
    await f.drafts.acknowledge(
      f.project.id,
      a,
      await f.projects.open(f.project.id),
    ),
    false,
  );
  assert.equal(await f.drafts.discard(f.project.id, a), false);
  await assert.rejects(
    f.drafts.protect(f.project, { ...f.trim(3), sessionId: 'name' }),
    /身份已变化/,
  );
  await f.projects.update(f.project.id, { name: 'B' });
  assert.equal(
    await f.drafts.acknowledge(
      f.project.id,
      b,
      await f.projects.open(f.project.id),
    ),
    true,
  );
  await f.drafts.protect(f.project, a);
  assert.deepEqual(await readdir(f.drafts.files.directory), []);
  const cancelled = f.name('明确取消', 1, 'cancel');
  await f.drafts.protect(f.project, cancelled);
  assert.equal(await f.drafts.discard(f.project.id, cancelled), true);
  await f.drafts.protect(f.project, cancelled);
  assert.deepEqual((await f.drafts.list(f.project.id)).drafts, []);
});

test('real name commits A then B survive two lost replies without advancing the editor sequence or rewriting committed B', async (t) => {
  const f = await fixture(t);
  const a = f.name('A');
  await f.drafts.protect(f.project, a);
  const loseReply = (input: ProjectEditDraftInput) =>
    f.drafts.recover(f.project, input, async (record, verify) => {
      await f.projects.restoreProjectEdit(f.project.id, record, verify);
      throw new Error('lost reply after SQLite commit');
    });
  await assert.rejects(loseReply(a), /lost reply/);
  assert.equal((await f.projects.open(f.project.id)).project.name, 'A');
  const b = { ...f.name('B', 2), lastSubmitted: 'A' };
  await f.drafts.protect(f.project, b);
  await assert.rejects(loseReply(b), /lost reply/);
  assert.equal((await f.drafts.get(f.project.id, b)).seq, 2);
  const before = await readFile(f.database);
  const saved = await f.recover(b, f.service());
  assert.equal(saved.project.name, 'B');
  assert.deepEqual(await readFile(f.database), before);
  assert.deepEqual((await f.drafts.list(f.project.id)).drafts, []);
});

test('trim recovery preserves unrelated saved work and a committed target never increments revision twice', async (t) => {
  const f = await fixture(t);
  const draft = f.trim();
  await f.drafts.protect(f.project, draft);
  const other = f.snapshot.canvas.cards[1];
  assert.ok(other);
  await f.projects.patchCanvas(f.project.id, {
    before: [other],
    after: [{ ...other, position: { x: 901, y: 502 } }],
  });
  await f.projects.update(f.project.id, {
    name: '另行确认的名称',
    viewport: { x: 7, y: 8, zoom: 1.3 },
  });
  withProject(
    f.database,
    true,
    (db) => {
      db.prepare('INSERT INTO metadata VALUES (?, ?)').run(
        'generation-workspace',
        JSON.stringify({ preserve: '独立工作区' }),
      );
    },
    f.project,
  );
  await assert.rejects(
    f.drafts.recover(f.project, draft, async (record, verify) => {
      await f.projects.restoreProjectEdit(f.project.id, record, verify);
      throw new Error('lost trim reply');
    }),
    /lost trim reply/,
  );
  const committed = await f.projects.open(f.project.id);
  assert.equal(committed.canvas.revision, 2);
  const before = await readFile(f.database);
  const saved = await f.recover(draft, f.service());
  assert.deepEqual(saved, committed);
  assert.deepEqual(await readFile(f.database), before);
  assert.equal(saved.project.name, '另行确认的名称');
  assert.deepEqual(saved.viewport, { x: 7, y: 8, zoom: 1.3 });
  assert.deepEqual(
    saved.canvas.cards.find((card) => card.id === other.id)?.position,
    { x: 901, y: 502 },
  );
  assert.equal(
    withProject(
      f.database,
      false,
      (db) =>
        db
          .prepare(
            "SELECT value FROM metadata WHERE key = 'generation-workspace'",
          )
          .get()?.value,
      f.project,
    ),
    JSON.stringify({ preserve: '独立工作区' }),
  );
});

test('trim B continues from the protected exact submission A; changed cards are never treated as an acknowledgement', async (t) => {
  const f = await fixture(t);
  const a = f.trim();
  await f.projects.patchCanvas(f.project.id, {
    before: [a.baseline],
    after: [a.target],
  });
  const b = { ...f.trim(2, 3), lastSubmitted: a.target };
  await f.drafts.protect(f.project, b);
  const saved = await f.recover(b);
  assert.equal(saved.canvas.revision, 2);
  assert.deepEqual(
    saved.canvas.cards.find((card) => card.id === b.baseline.id),
    b.target,
  );
  const conflict = { ...f.trim(3, 4), sessionId: 'conflict' };
  await f.drafts.protect(f.project, conflict);
  const before = await readFile(f.database);
  await assert.rejects(f.recover(conflict), /恢复基线不同/);
  assert.deepEqual(await readFile(f.database), before);
  assert.equal(
    await f.drafts.acknowledge(f.project.id, conflict, saved),
    false,
  );
  assert.equal((await f.drafts.list(f.project.id)).drafts.length, 1);
});

test('the actual trim transaction rejects changes to every source record field, including after the draft preflight', async (t) => {
  const replacements: Partial<Asset>[] = [
    { id: randomUUID() },
    { name: '被替换的来源' },
    { relativePath: 'assets/videos/other.mp4' },
    { size: 99 },
    { sha256: 'f'.repeat(64) },
    { kind: 'image' },
    { usage: 'reference' },
  ];
  for (const replacement of replacements) {
    const f = await fixture(t);
    const draft = f.trim();
    await f.drafts.protect(f.project, draft);
    let changed!: Buffer;
    await assert.rejects(
      f.drafts.recover(f.project, draft, (record, verify) =>
        f.projects.restoreProjectEdit(f.project.id, record, async () => {
          await verify();
          withProject(
            f.database,
            true,
            (db) => {
              const asset = draft.assets[0];
              assert.ok(asset);
              db.prepare('UPDATE assets SET payload = ? WHERE id = ?').run(
                JSON.stringify({ ...asset, ...replacement }),
                asset.id,
              );
            },
            f.project,
          );
          changed = await readFile(f.database);
        }),
      ),
      /恢复基线不同|引用了不存在/,
    );
    assert.deepEqual(await readFile(f.database), changed);
    assert.equal((await f.drafts.list(f.project.id)).drafts.length, 1);
  }
});

test('a recovery waiting for the project gate locks only its editor stream; close waits for its exact durable confirmation', async (t) => {
  const f = await fixture(t);
  const draft = f.name();
  await f.drafts.protect(f.project, draft);
  const release = deferred();
  const entered = deferred();
  const holding = f.gate.run(() => release.promise);
  const recovery = f.drafts.recover(f.project, draft, (record, verify) => {
    entered.resolve();
    return f.projects.restoreProjectEdit(f.project.id, record, verify);
  });
  await entered.promise;
  await assert.rejects(
    f.drafts.protect(f.project, f.name('newer', 2)),
    /正在恢复/,
  );
  await assert.rejects(f.drafts.discard(f.project.id, draft), /正在恢复/);
  await assert.rejects(f.recover(draft), /正在恢复/);
  await f.drafts.protect(f.project, f.trim());
  let closed = false;
  const closing = f.drafts.close().then(() => {
    closed = true;
  });
  await assert.rejects(
    f.drafts.protect(f.project, f.name('late', 1, 'late')),
    /正在关闭/,
  );
  assert.equal(closed, false);
  release.resolve();
  await holding;
  assert.equal((await recovery).project.name, draft.target);
  await closing;
  const retained = await f.service().list(f.project.id);
  assert.deepEqual(
    retained.drafts.map((record) => record.kind),
    ['trim'],
  );
});

test('a replaced draft while waiting for the project gate prevents the old key from submitting or deleting the replacement', async (t) => {
  const f = await fixture(t);
  const draft = f.name();
  await f.drafts.protect(f.project, draft);
  const release = deferred();
  const entered = deferred();
  const holding = f.gate.run(() => release.promise);
  const recovery = f.drafts.recover(f.project, draft, (record, verify) => {
    entered.resolve();
    return f.projects.restoreProjectEdit(f.project.id, record, verify);
  });
  await entered.promise;
  const replacement = {
    ...JSON.parse(await readFile(f.file(), 'utf8')),
    target: '外部保留内容',
  };
  await rename(f.file(), `${f.file()}.original`);
  await writeFile(f.file(), JSON.stringify(replacement));
  const bytes = await readFile(f.file());
  const rejected = assert.rejects(recovery, /等待保存期间变化/);
  release.resolve();
  await holding;
  await rejected;
  assert.equal(
    (await f.projects.open(f.project.id)).project.name,
    f.project.name,
  );
  assert.deepEqual(await readFile(f.file()), bytes);
  assert.equal(
    JSON.parse(await readFile(`${f.file()}.original`, 'utf8')).target,
    draft.target,
  );
});

test('corrupt, unknown and linked recovery files are reported and retained without blocking valid sibling streams', async (t) => {
  const f = await fixture(t);
  await f.drafts.protect(f.project, f.name());
  const valid = JSON.parse(await readFile(f.file(), 'utf8'));
  const future = { ...valid, sessionId: 'future', version: 99 };
  await writeFile(f.file('future'), JSON.stringify(future));
  await writeFile(f.file('broken'), '{broken');
  const outside = join(f.base, 'outside.json');
  await writeFile(outside, JSON.stringify({ ...valid, sessionId: 'link' }));
  await symlink(outside, f.file('link'));
  const found = await f.drafts.list(f.project.id);
  assert.equal(found.drafts.length, 1);
  assert.equal(found.issues.length, 3);
  await assert.rejects(
    f.drafts.protect(f.project, f.name('new', 2, 'future')),
    /版本不受支持/,
  );
  await assert.rejects(
    f.drafts.discard(f.project.id, { sessionId: 'broken', seq: 1 }),
    /JSON/,
  );
  await assert.rejects(
    f.drafts.protect(f.project, f.name('new', 2, 'link')),
    /无效/,
  );
  assert.equal(
    await readFile(f.file('future'), 'utf8'),
    JSON.stringify(future),
  );
  assert.equal(await readFile(f.file('broken'), 'utf8'), '{broken');
  assert.equal(
    await readFile(outside, 'utf8'),
    JSON.stringify({ ...valid, sessionId: 'link' }),
  );
  await f.recover(f.name());
});

test('interrupted atomic protection and quota exhaustion keep the last complete editor record', async (t) => {
  const f = await fixture(t);
  await f.drafts.protect(f.project, f.name('A'));
  const original = await readFile(f.file());
  const probe = await open(join(f.base, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const fault = t.mock.method(prototype, 'sync', async () => {
    throw new Error('injected sync failure');
  });
  await assert.rejects(
    f.drafts.protect(f.project, f.name('B', 2)),
    /sync failure/,
  );
  fault.mock.restore();
  assert.deepEqual(await readFile(f.file()), original);
  assert.deepEqual(await readdir(f.drafts.files.directory), [
    `${f.project.id}.name.json`,
  ]);
  const filler = join(f.drafts.files.directory, 'user-file-retained');
  await writeFile(filler, '');
  await truncate(filler, MAX_DRAFT_STORAGE_BYTES - original.length);
  await f.drafts.protect(f.project, f.name('B', 2));
  const current = await readFile(f.file());
  await assert.rejects(
    f.drafts.protect(f.project, f.name('larger', 3)),
    /空间/,
  );
  assert.deepEqual(await readFile(f.file()), current);
});

test('editor rescue exports retain raw input and original records and cannot overwrite existing destinations', async (t) => {
  const f = await fixture(t);
  const name = f.name('  ');
  await f.drafts.protect(f.project, name);
  const before = await readFile(f.file());
  const destination = join(f.base, '中文 名称.afflatus-edit-draft.json');
  await f.drafts.export(f.project, name, destination);
  const exported = await readFile(destination);
  assert.equal(
    JSON.parse(exported.toString()).format,
    'infinite-afflatus-project-edit-rescue',
  );
  assert.equal(JSON.parse(exported.toString()).draft.target, '  ');
  await assert.rejects(f.drafts.export(f.project, name, destination), {
    code: 'EEXIST',
  });
  assert.deepEqual(await readFile(destination), exported);
  assert.deepEqual(await readFile(f.file()), before);
  const trim = f.trim();
  const other = join(f.base, '裁剪.afflatus-edit-draft.json');
  await f.drafts.export(f.project, { snapshot: trim }, other);
  assert.deepEqual(
    JSON.parse(await readFile(other, 'utf8')).draft.assets,
    trim.assets,
  );
  assert.equal((await f.drafts.list(f.project.id)).drafts.length, 1);
});

test('acknowledgement cannot remove a same-sequence record replaced between confirmation and unlink', async (t) => {
  const f = await fixture(t);
  const draft = f.name();
  await f.drafts.protect(f.project, draft);
  await f.projects.update(f.project.id, { name: draft.target });
  const replacement = {
    ...JSON.parse(await readFile(f.file(), 'utf8')),
    target: '外部尚未保存内容',
  };
  const remove = f.drafts.files.remove.bind(f.drafts.files);
  t.mock.method(
    f.drafts.files,
    'remove',
    async (...args: Parameters<typeof remove>) => {
      await rename(f.file(), `${f.file()}.original`);
      await writeFile(f.file(), JSON.stringify(replacement));
      return remove(...args);
    },
  );
  await assert.rejects(
    f.drafts.acknowledge(
      f.project.id,
      draft,
      await f.projects.open(f.project.id),
    ),
    /清理期间变化/,
  );
  assert.equal(await readFile(f.file(), 'utf8'), JSON.stringify(replacement));
  assert.equal(
    JSON.parse(await readFile(`${f.file()}.original`, 'utf8')).target,
    draft.target,
  );
});

test('mismatched stream files, moved recovery directories and structural edits are never adopted', async (t) => {
  const f = await fixture(t);
  const draft = f.name();
  await f.drafts.protect(f.project, draft);
  const mismatched = {
    ...JSON.parse(await readFile(f.file(), 'utf8')),
    sessionId: 'different-stream',
  };
  await writeFile(f.file(), JSON.stringify(mismatched));
  await assert.rejects(f.recover(draft), /草稿已变化/);
  await assert.rejects(
    f.drafts.protect(f.project, f.name('B', 2)),
    /身份已变化/,
  );
  assert.equal(await f.drafts.discard(f.project.id, draft), false);
  assert.equal(await readFile(f.file(), 'utf8'), JSON.stringify(mismatched));
  const trim = f.trim();
  assert.throws(
    () =>
      f.drafts.protect(f.project, {
        ...trim,
        target: { ...trim.target, position: { x: 999, y: 999 } },
      }),
    /只能调整/,
  );
  const directory = f.drafts.files.directory;
  await rename(directory, `${directory}.original`);
  await mkdir(directory);
  await writeFile(f.file(), 'user replacement');
  await assert.rejects(
    f.drafts.protect(f.project, f.name('B', 2)),
    /目录已变化/,
  );
  assert.equal(await readFile(f.file(), 'utf8'), 'user replacement');
  assert.equal(
    await readFile(
      join(`${directory}.original`, `${f.project.id}.name.json`),
      'utf8',
    ),
    JSON.stringify(mismatched),
  );
});

test('an actual unlink failure after a name commit returns the saved snapshot and retains the same sequence for later cleanup', async (t) => {
  const f = await fixture(t);
  const draft = f.name('已提交名称');
  await f.drafts.protect(f.project, draft);
  const original = await readFile(f.file());
  const unlink = fs.unlink.bind(fs);
  let injected = false;
  const failure = t.mock.method(
    fs,
    'unlink',
    async (path: Parameters<typeof unlink>[0]) => {
      if (path === f.file() && !injected) {
        injected = true;
        throw Object.assign(new Error('injected draft unlink denied'), {
          code: 'EACCES',
        });
      }
      return unlink(path);
    },
  );
  syncBuiltinESMExports();
  const warnings = t.mock.method(console, 'warn', () => {});
  try {
    const saved = await f.recover(draft);
    assert.equal(injected, true);
    assert.equal(saved.project.name, draft.target);
    assert.deepEqual(saved.canvas, f.snapshot.canvas);
    assert.deepEqual(await readFile(f.file()), original);
    assert.equal((await f.drafts.get(f.project.id, draft)).seq, draft.seq);
    assert.equal(warnings.mock.callCount(), 1);
    const committed = await readFile(f.database);
    assert.equal((await f.recover(draft)).project.name, draft.target);
    assert.deepEqual(await readFile(f.database), committed);
    assert.deepEqual((await f.drafts.list(f.project.id)).drafts, []);
  } finally {
    failure.mock.restore();
    syncBuiltinESMExports();
  }
});

test('a directory fsync failure after trim cleanup never reports the committed trim as a failed write', async (t) => {
  if (process.platform === 'win32') {
    t.skip(
      'Windows does not open or fsync directories; unlink failure is covered on every platform',
    );
    return;
  }
  const f = await fixture(t);
  const draft = f.trim();
  await f.drafts.protect(f.project, draft);
  const probe = await open(join(f.base, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const sync = prototype.sync;
  let injected = false;
  const failure = t.mock.method(
    prototype,
    'sync',
    async function (this: Awaited<ReturnType<typeof open>>) {
      if ((await this.stat()).isDirectory() && !injected) {
        injected = true;
        throw new Error('injected directory fsync failure after unlink');
      }
      return sync.call(this);
    },
  );
  const warnings = t.mock.method(console, 'warn', () => {});
  const saved = await f.recover(draft);
  failure.mock.restore();
  assert.equal(injected, true);
  assert.equal(warnings.mock.callCount(), 1);
  assert.equal(saved.canvas.revision, f.snapshot.canvas.revision + 1);
  assert.deepEqual(
    saved.canvas.cards.find((card) => card.id === draft.target.id),
    draft.target,
  );
  await assert.rejects(readFile(f.file('trim')), { code: 'ENOENT' });
  assert.deepEqual((await f.projects.open(f.project.id)).canvas, saved.canvas);
  assert.equal(await f.drafts.acknowledge(f.project.id, draft, saved), false);
  assert.deepEqual((await f.drafts.list(f.project.id)).drafts, []);
});

test('replacement evidence after the project commits is retained without changing the successful save into a rejection', async (t) => {
  const f = await fixture(t);
  const draft = f.name();
  await f.drafts.protect(f.project, draft);
  const original = await readFile(f.file());
  const replacement = '{unreadable external replacement';
  const warnings = t.mock.method(console, 'warn', () => {});
  const saved = await f.drafts.recover(
    f.project,
    draft,
    async (record, verify) => {
      const result = await f.projects.restoreProjectEdit(
        f.project.id,
        record,
        verify,
      );
      await rename(f.file(), `${f.file()}.original`);
      await writeFile(f.file(), replacement);
      return result;
    },
  );
  assert.equal(saved.project.name, draft.target);
  assert.equal(warnings.mock.callCount(), 1);
  assert.equal(await readFile(f.file(), 'utf8'), replacement);
  assert.deepEqual(await readFile(`${f.file()}.original`), original);
  const list = await f.drafts.list(f.project.id);
  assert.deepEqual(list.drafts, []);
  assert.equal(list.issues.length, 1);
});
