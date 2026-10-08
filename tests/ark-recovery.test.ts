import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ArkJournal } from '../src/main/generation/ark-journal';
import { arkFixture, mockTransport } from './ark-generation-fixture';

async function submit(f: Awaited<ReturnType<typeof arkFixture>>) {
  const preview = await f.service.preview('window', f.target);
  return f.service.submit('window', preview.token);
}
test('index restore missing queue recovers only proven committed candidate', async (t) => {
  let downloads = 0;
  const original = mockTransport();
  const f = await arkFixture(
    'image',
    mockTransport({
      download: async (...args) => {
        downloads++;
        return original.download(...args);
      },
    }),
  );
  t.after(() => f.dispose());
  await submit(f);
  const [candidate] = await f.settle();
  assert.ok(candidate?.saveJobId);
  const save = f.library.store.job(candidate.saveJobId);
  f.library.store.deleteJob(save.id, JSON.stringify(save));
  f.library.store.set('appBackupRecovery', {
    restoredAt: 'fixture-new-index',
    source: 'fixture',
  });
  await f.restart();
  await f.service.idle();
  assert.equal(f.service.list(f.project.id)[0]?.phase, 'candidate');
  assert.equal(f.library.store.jobs().length, 0);
  assert.equal(downloads, 1);
  const ws = await f.library.generation.readWorkspace(f.project.id);
  const adopted = await f.service.adopt(candidate.id, ws.revision);
  assert.equal(adopted.assetId, save.id);
});

test('index restore retains staged bytes without replaying old queue or downloading again', async (t) => {
  let downloads = 0;
  let posts = 0;
  const original = mockTransport();
  const f = await arkFixture(
    'image',
    mockTransport({
      createImage: async (...args) => {
        posts++;
        return original.createImage(...args);
      },
      download: async (...args) => {
        downloads++;
        return original.download(...args);
      },
    }),
  );
  t.after(() => f.dispose());
  await f.library.gate.block();
  t.after(() => f.library.gate.release());
  const job = await submit(f);
  await f.service.idle();
  const saved = f.service.list(f.project.id)[0];
  assert.ok(saved?.saveJobId);
  const save = f.library.store.job(saved.saveJobId);
  const bytes = await readFile(f.library.staging.path(save.id));
  f.library.store.deleteJob(save.id, JSON.stringify(save));
  f.library.store.set('appBackupRecovery', {
    restoredAt: 'fixture-index-restore',
  });
  await f.restart();
  await f.service.idle();
  assert.equal(f.service.list(f.project.id)[0]?.phase, 'recovery_blocked');
  assert.match(f.service.list(f.project.id)[0]?.error ?? '', /不会自动重放/);
  await f.service.retrySave(job.id);
  await f.service.retryDownload(job.id);
  assert.deepEqual(await readFile(f.library.staging.path(save.id)), bytes);
  assert.equal(f.library.store.jobs().length, 0);
  assert.equal(downloads, 1);
  assert.equal(posts, 1);
  f.library.gate.release();
});

test('complete .part publication failure can retry same output while preserving original bytes', async (t) => {
  let posts = 0;
  let downloads = 0;
  const original = mockTransport();
  const f = await arkFixture(
    'image',
    mockTransport({
      createImage: async (...args) => {
        posts++;
        return original.createImage(...args);
      },
      download: async (...args) => {
        downloads++;
        return original.download(...args);
      },
    }),
  );
  t.after(() => f.dispose());
  const actualPath = f.library.staging.path.bind(f.library.staging);
  const blocked = join(f.base, 'publication-is-a-directory');
  await mkdir(blocked);
  // Inject rename failure without modifying production staging behavior.
  f.library.staging.path = () => blocked;
  const job = await submit(f);
  await f.service.idle();
  f.library.staging.path = actualPath;
  const [failed] = f.service.list(f.project.id);
  assert.equal(failed?.phase, 'download_failed');
  assert.match(failed?.error ?? '', /暂存发布未完成/);
  const old = f.library.store.jobs()[0];
  assert.ok(old?.sha256);
  const oldPart = join(f.library.staging.directory, `${old.id}.part`);
  const bytes = await readFile(oldPart);
  await rmdir(blocked);
  await f.service.retryDownload(job.id);
  const [candidate] = await f.settle();
  assert.equal(candidate?.phase, 'candidate');
  assert.notEqual(candidate?.saveJobId, old.id);
  assert.deepEqual(await readFile(oldPart), bytes);
  assert.equal(f.library.store.job(old.id).status, 'failed');
  assert.equal(posts, 1);
  assert.equal(downloads, 2);
});

test('shutdown of an in-flight POST preserves submission_unknown and never sends DELETE', async (t) => {
  let posts = 0;
  let started = () => {};
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await arkFixture(
    'video',
    mockTransport({
      createVideo: async (_request, _key, signal) => {
        posts++;
        started();
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('fixture interrupted')),
            { once: true },
          );
        });
      },
    }),
  );
  t.after(() => f.dispose());
  await submit(f);
  await pending;
  await f.restart();
  assert.equal(f.service.list(f.project.id)[0]?.phase, 'submission_unknown');
  assert.equal(posts, 1);
});

test('window invalidation during final preflight never creates a durable attempt or POST', async (t) => {
  let posts = 0;
  const f = await arkFixture(
    'image',
    mockTransport({
      createImage: async () => {
        posts++;
        return { url: 'https://fixture.invalid/result' };
      },
    }),
  );
  t.after(() => f.dispose());
  const preview = await f.service.preview('window', f.target);
  await assert.rejects(
    f.service.submit('window', preview.token, () => {
      throw new Error('window changed');
    }),
    /window changed/,
  );
  assert.equal(posts, 0);
  assert.equal(f.service.list(f.project.id).length, 0);
});

test('journal rejects malformed public fields and mismatched row IDs without altering rows', async (t) => {
  const f = await arkFixture();
  t.after(() => f.dispose());
  const job = await submit(f);
  await f.settle();
  await f.service.close();
  const file = join(f.cloudData, 'ark-generation.sqlite');
  const db = new DatabaseSync(file);
  const original = String(
    db.prepare('SELECT payload FROM jobs WHERE id = ?').get(job.id)?.payload,
  );
  const invalid = [
    { parameters: null },
    { references: [null] },
    { error: {} },
    { saveJobId: '../file' },
    { resultSize: -1 },
    { resultSha256: 'bad' },
    { id: '00000000-0000-4000-8000-000000000000' },
    { phase: 'running', remoteTaskId: undefined },
    { shotContext: { ...JSON.parse(original).shotContext, id: 'other-shot' } },
  ];
  for (const change of invalid) {
    const payload = JSON.stringify({ ...JSON.parse(original), ...change });
    db.prepare('UPDATE jobs SET payload = ? WHERE id = ?').run(payload, job.id);
    const journal = new ArkJournal(file);
    assert.throws(() => journal.list(), /记录|画布|参数|远端任务/);
    journal.close();
    assert.equal(
      db.prepare('SELECT payload FROM jobs WHERE id = ?').get(job.id)?.payload,
      payload,
    );
  }
  db.prepare('UPDATE jobs SET payload = ? WHERE id = ?').run(original, job.id);
  db.close();
  await f.restart();
  assert.equal(f.service.list(f.project.id)[0]?.phase, 'candidate');
});

test('restored committed bytes changed on disk remain blocked and are not overwritten', async (t) => {
  const f = await arkFixture();
  t.after(() => f.dispose());
  await submit(f);
  const [candidate] = await f.settle();
  assert.ok(candidate?.saveJobId);
  const save = f.library.store.job(candidate.saveJobId);
  const project = await f.library.projects.open(f.project.id);
  const asset = project.assets.find((item) => item.id === save.id);
  assert.ok(asset);
  const path = join(f.library.store.root, f.project.folder, asset.relativePath);
  await rename(path, `${path}.retained`);
  f.library.store.deleteJob(save.id, JSON.stringify(save));
  await f.restart();
  await f.service.idle();
  assert.equal(f.service.list(f.project.id)[0]?.phase, 'recovery_blocked');
  assert.ok((await readFile(`${path}.retained`)).length > 0);
});

test('explicit query after index restore resumes only the original known pre-result task', async (t) => {
  let posts = 0;
  let gets = 0;
  let downloads = 0;
  const original = mockTransport();
  const f = await arkFixture(
    'video',
    mockTransport({
      createVideo: async (...args) => {
        posts++;
        return original.createVideo(...args);
      },
      getVideo: async (id, ...args) => {
        gets++;
        assert.equal(id, 'cgt-fixture-task');
        return original.getVideo(id, ...args);
      },
      download: async (...args) => {
        downloads++;
        return original.download(...args);
      },
    }),
  );
  t.after(() => f.dispose());
  const job = await submit(f);
  await f.service.idle();
  assert.equal(f.service.list(f.project.id)[0]?.phase, 'queued');
  f.library.store.set('appBackupRecovery', {
    restoredAt: 'known-task-new-index',
  });
  await f.restart();
  await f.service.idle();
  const blocked = f.service.list(f.project.id)[0];
  assert.equal(blocked?.phase, 'recovery_blocked');
  assert.equal(blocked?.canResumeOriginalTask, true);
  assert.equal(gets, 0);
  assert.equal(downloads, 0);
  assert.equal(f.library.store.jobs().length, 0);
  await f.service.refresh(job.id);
  const [candidate] = await f.settle();
  assert.equal(candidate?.phase, 'candidate');
  assert.equal(candidate?.canResumeOriginalTask, undefined);
  assert.equal(posts, 1);
  assert.equal(gets, 1);
  assert.equal(downloads, 1);
  assert.equal(f.library.store.jobs().length, 1);
  await f.service.refresh(job.id);
  assert.equal(gets, 1);
});
