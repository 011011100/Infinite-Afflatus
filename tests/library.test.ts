import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cleanupMigration } from '../src/main/migration/cleanup';
import { readProject } from '../src/main/projects/project-database';
import { Library } from '../src/main/storage/library';

async function fixture(quota?: number) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'afflatus-test-')));
  const data = join(base, 'app');
  const root = join(base, 'projects');
  const target = join(base, 'moved');
  await mkdir(target);
  const library = await Library.open(data, root, quota);
  return {
    base,
    data,
    root,
    target,
    library,
    async dispose() {
      await library.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function addResult(
  library: Library,
  projectId: string,
  resultKey = 'task-1:output-1',
) {
  const job = await library.acceptResult(
    { projectId, resultKey, name: '雨巷.mp4', kind: 'video', extension: 'mp4' },
    Readable.from(Buffer.from('fake video bytes for storage testing')),
  );
  await library.saves.idle();
  return library.store.job(job.id);
}

test('projects persist name, canvas position and assets; duplicate callbacks do not duplicate assets', async () => {
  const f = await fixture();
  try {
    const first = await f.library.projects.create('雨夜归途');
    await f.library.projects.create('雨夜归途');
    await f.library.projects.update(first.project.id, {
      name: '雨夜',
      viewport: { x: 123, y: -45, zoom: 0.8 },
    });
    const saved = await addResult(f.library, first.project.id);
    assert.equal(saved.status, 'saved');
    assert.equal((await addResult(f.library, first.project.id)).id, saved.id);
    const fresh = readProject(
      join(f.root, first.project.folder, 'project.sqlite'),
    );
    assert.equal(fresh.project.name, '雨夜');
    assert.deepEqual(fresh.viewport, { x: 123, y: -45, zoom: 0.8 });
    assert.equal(fresh.assets.length, 1);
    assert.equal(f.library.state().projects.length, 2);
    assert.deepEqual(await readdir(join(f.data, 'staging')), []);
  } finally {
    await f.dispose();
  }
});

test('staging remains durable while project writes are blocked; queued writes follow the new root', async () => {
  const f = await fixture();
  try {
    const { project } = await f.library.projects.create('迁移中的生成任务');
    await f.library.gate.block();
    const staged = await addResult(f.library, project.id);
    assert.equal(staged.status, 'ready');
    assert.equal((await f.library.projects.open(project.id)).assets.length, 0);
    assert.ok((await readFile(f.library.staging.path(staged.id))).length);
    f.library.gate.release();
    const preview = await f.library.migration.prepare(f.target);
    await f.library.migration.start(preview.token);
    await f.library.migration.idle();
    await f.library.saves.idle();
    assert.equal(f.library.state().root, f.target);
    assert.equal(f.library.store.job(staged.id).status, 'saved');
    assert.equal((await f.library.projects.open(project.id)).assets.length, 1);
    assert.deepEqual(await readdir(f.root), []);
  } finally {
    await f.dispose();
  }
});

test('migration removes only exact managed duplicates and preserves user files at every level', async () => {
  const f = await fixture();
  try {
    const { project } = await f.library.projects.create('安全迁移');
    await addResult(f.library, project.id);
    const userFiles = [
      'notes.txt',
      `${project.id}/other.txt`,
      `${project.id}/assets/user.mp4`,
      `${project.id}/cache/personal.txt`,
    ];
    for (const path of userFiles)
      await writeFile(join(f.root, path), 'keep me');
    const preview = await f.library.migration.prepare(f.target);
    await f.library.migration.start(preview.token);
    await f.library.migration.idle();
    assert.equal(f.library.state().migration?.phase, 'completed');
    for (const path of userFiles)
      assert.equal(await readFile(join(f.root, path), 'utf8'), 'keep me');
    await assert.rejects(readFile(join(f.root, project.id, 'project.sqlite')), {
      code: 'ENOENT',
    });
    assert.equal((await f.library.projects.open(project.id)).assets.length, 1);
  } finally {
    await f.dispose();
  }
});

test('cancellation before switching keeps the old root and original assets usable', async () => {
  const f = await fixture();
  try {
    const { project } = await f.library.projects.create('取消测试');
    await addResult(f.library, project.id);
    const stop = f.library.subscribe(() => {
      if (f.library.state().migration?.phase === 'copying')
        f.library.migration.cancel();
    });
    const preview = await f.library.migration.prepare(f.target);
    await f.library.migration.start(preview.token);
    await f.library.migration.idle();
    stop();
    assert.equal(f.library.state().root, f.root);
    assert.equal(f.library.state().migration?.phase, 'cancelled');
    assert.equal((await f.library.projects.open(project.id)).assets.length, 1);
    assert.deepEqual(await readdir(f.target), []);
  } finally {
    await f.dispose();
  }
});

test('cleanup preserves a managed file replaced after copying', async () => {
  const f = await fixture();
  try {
    const { project } = await f.library.projects.create('保护变动文件');
    await addResult(f.library, project.id);
    const asset = (await f.library.projects.open(project.id)).assets[0];
    assert.ok(asset);
    let changed = false;
    // Change the source after the durable switch, before cleanup can unlink it.
    const stop = f.library.subscribe(() => {
      if (!changed && f.library.state().root === f.target) {
        changed = true;
        writeFileSync(
          join(f.root, project.id, asset.relativePath),
          'user replacement',
        );
      }
    });
    const preview = await f.library.migration.prepare(f.target);
    await f.library.migration.start(preview.token);
    await f.library.migration.idle();
    stop();
    assert.equal(
      await readFile(join(f.root, project.id, asset.relativePath), 'utf8'),
      'user replacement',
    );
    assert.ok(
      f.library
        .state()
        .migration?.warnings.some((warning) => warning.includes('文件已变化')),
    );
  } finally {
    await f.dispose();
  }
});

for (const phase of ['verifying', 'cleaning']) {
  test(`process restart recovers a migration interrupted at ${phase}, and drains its persisted save queue`, async () => {
    const base = await realpath(
      await mkdtemp(join(tmpdir(), 'afflatus-crash-')),
    );
    await mkdir(join(base, 'moved'));
    let reopened: Library | null = null;
    try {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          fileURLToPath(
            new URL('./fixtures/interrupted-migration.ts', import.meta.url),
          ),
          base,
          phase,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let error = '';
      child.stderr.on('data', (chunk: Buffer) => {
        error += chunk.toString();
      });
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      assert.equal(exitCode, 73, error);
      reopened = await Library.open(join(base, 'app'), join(base, 'projects'));
      await reopened.saves.idle();
      assert.equal(
        reopened.state().root,
        join(base, phase === 'cleaning' ? 'moved' : 'projects'),
      );
      const project = reopened.state().projects[0];
      assert.ok(project);
      assert.equal((await reopened.projects.open(project.id)).assets.length, 2);
      assert.ok(reopened.state().jobs.every((job) => job.status === 'saved'));
      assert.equal(
        reopened.state().migration?.phase,
        phase === 'cleaning' ? 'completed' : 'failed',
      );
      assert.deepEqual(
        await readdir(join(base, phase === 'cleaning' ? 'projects' : 'moved')),
        [],
      );
    } finally {
      await reopened?.close();
      await rm(base, { recursive: true, force: true });
    }
  });
}

test('migration waits for an admitted write and rejects later project writes while staging continues', async () => {
  const f = await fixture();
  try {
    const { project } = await f.library.projects.create('写入屏障');
    const preview = await f.library.migration.prepare(f.target);
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inFlight = f.library.gate.run(() => barrier);
    const migration = f.library.migration.start(preview.token);
    assert.equal(f.library.gate.isBlocked, true);
    await assert.rejects(f.library.projects.create('不应创建'), /迁移/);
    const pending = await addResult(f.library, project.id);
    assert.equal(pending.status, 'ready');
    assert.equal(f.library.state().root, f.root);
    release();
    await inFlight;
    await migration;
    await f.library.migration.idle();
    await f.library.saves.idle();
    assert.equal(f.library.store.job(pending.id).status, 'saved');
    assert.equal(f.library.state().root, f.target);
  } finally {
    await f.dispose();
  }
});

test('failed saves retain their complete result and retry without generating again', async () => {
  const f = await fixture();
  try {
    const { project } = await f.library.projects.create('保存重试');
    await f.library.gate.block();
    const pending = await addResult(f.library, project.id);
    const parent = join(f.root, project.id, 'assets', 'videos');
    await rm(parent, { recursive: true });
    await writeFile(parent, 'user-owned obstruction');
    f.library.gate.release();
    f.library.saves.kick();
    await f.library.saves.idle();
    assert.equal(f.library.store.job(pending.id).status, 'failed');
    assert.ok((await readFile(f.library.staging.path(pending.id))).length);
    assert.equal(await readFile(parent, 'utf8'), 'user-owned obstruction');
    await rm(parent);
    await mkdir(parent);
    await f.library.saves.retry(pending.id);
    await f.library.saves.idle();
    assert.equal(f.library.store.job(pending.id).status, 'saved');
    assert.equal((await f.library.projects.open(project.id)).assets.length, 1);
  } finally {
    await f.dispose();
  }
});

test('a symlink in managed assets blocks migration without touching its target', async () => {
  const f = await fixture();
  try {
    const { project } = await f.library.projects.create('链接保护');
    await addResult(f.library, project.id);
    const asset = (await f.library.projects.open(project.id)).assets[0];
    assert.ok(asset);
    const file = join(f.root, project.id, asset.relativePath);
    const outside = join(f.base, 'outside.mp4');
    await writeFile(outside, 'external');
    await rm(file);
    await symlink(outside, file);
    await assert.rejects(f.library.migration.prepare(f.target), /符号链接/);
    assert.equal(await readFile(outside, 'utf8'), 'external');
  } finally {
    await f.dispose();
  }
});

test('recovery handles a project commit that succeeded before the save acknowledgement', async () => {
  const f = await fixture();
  try {
    const { project } = await f.library.projects.create('恢复保存');
    const saved = await addResult(f.library, project.id);
    f.library.store.putJob({ ...saved, status: 'saving' });
    await f.library.staging.recover();
    f.library.saves.kick();
    await f.library.saves.idle();
    assert.equal(f.library.store.job(saved.id).status, 'saved');
    assert.equal((await f.library.projects.open(project.id)).assets.length, 1);
  } finally {
    await f.dispose();
  }
});

test('quota exhaustion preserves prior staged results and marks the incomplete transfer failed', async () => {
  const f = await fixture(40);
  try {
    const { project } = await f.library.projects.create('暂存容量');
    await f.library.gate.block();
    const first = await addResult(f.library, project.id, 'one');
    assert.equal(first.status, 'ready');
    const second = await addResult(f.library, project.id, 'two');
    assert.equal(second.status, 'failed');
    assert.match(second.error ?? '', /上限/);
    assert.ok((await readFile(f.library.staging.path(first.id))).length);
    f.library.gate.release();
  } finally {
    await f.dispose();
  }
});

test('cleanup can be retried after project metadata changes at the destination', async () => {
  const f = await fixture();
  try {
    const { project } = await f.library.projects.create('重试清理');
    await addResult(f.library, project.id);
    const preview = await f.library.migration.prepare(f.target);
    await f.library.migration.start(preview.token);
    await f.library.migration.idle();
    await f.library.projects.update(project.id, { name: '迁移后改名' });
    const journal = f.library.migration.journal;
    assert.ok(journal);
    await cleanupMigration(journal, () => undefined);
    assert.equal(
      (await f.library.projects.open(project.id)).project.name,
      '迁移后改名',
    );
  } finally {
    await f.dispose();
  }
});

test('an unregistered conflicting destination is preserved and saving chooses a fresh file', async () => {
  const f = await fixture();
  try {
    const { project } = await f.library.projects.create('文件冲突');
    await f.library.gate.block();
    const pending = await addResult(f.library, project.id);
    const conflict = join(
      f.root,
      project.id,
      'assets/videos',
      `${pending.id}.mp4`,
    );
    await writeFile(conflict, 'unrelated user file');
    f.library.gate.release();
    f.library.saves.kick();
    await f.library.saves.idle();
    assert.equal(f.library.store.job(pending.id).status, 'saved');
    assert.equal(await readFile(conflict, 'utf8'), 'unrelated user file');
    const asset = (await f.library.projects.open(project.id)).assets[0];
    assert.ok(asset);
    assert.notEqual(join(f.root, project.id, asset.relativePath), conflict);
  } finally {
    await f.dispose();
  }
});

test('a newer project schema is rejected without modifying its database', async () => {
  const f = await fixture();
  try {
    const { project } = await f.library.projects.create('未来版本');
    const file = join(f.root, project.id, 'project.sqlite');
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 999');
    db.close();
    const before = await readFile(file);
    await assert.rejects(f.library.projects.open(project.id), /版本/);
    assert.deepEqual(await readFile(file), before);
  } finally {
    await f.dispose();
  }
});

test('the project index can be reconstructed from project folders', async () => {
  const f = await fixture();
  try {
    const { project } = await f.library.projects.create('独立项目');
    await addResult(f.library, project.id);
    await f.library.close();
    const alternate = await Library.open(
      join(f.base, 'recreated-app-data'),
      f.root,
    );
    try {
      assert.equal(alternate.state().projects[0]?.id, project.id);
      assert.equal(
        (await alternate.projects.open(project.id)).assets.length,
        1,
      );
    } finally {
      await alternate.close();
    }
  } finally {
    await f.dispose();
  }
});

test('startup uses the selected root even if the old default path is no longer a directory', async () => {
  const f = await fixture();
  try {
    await f.library.projects.create('当前目录');
    const preview = await f.library.migration.prepare(f.target);
    await f.library.migration.start(preview.token);
    await f.library.migration.idle();
    await f.library.close();
    await rm(f.root, { recursive: true });
    await writeFile(f.root, 'unrelated replacement at the old location');
    const reopened = await Library.open(f.data, f.root);
    try {
      assert.equal(reopened.state().root, f.target);
      assert.equal(reopened.state().projects.length, 1);
    } finally {
      await reopened.close();
    }
    assert.equal(
      await readFile(f.root, 'utf8'),
      'unrelated replacement at the old location',
    );
  } finally {
    await f.dispose();
  }
});
