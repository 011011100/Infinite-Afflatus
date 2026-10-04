import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { TestContext } from 'node:test';
import { AppBackupService } from '../../src/main/backups/app-backup-service';
import { ProjectService } from '../../src/main/projects/project-service';
import { Staging } from '../../src/main/saving/staging';
import { AppStore } from '../../src/main/storage/app-store';
import { WriteGate } from '../../src/main/storage/write-gate';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';

export const backupHash = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');

export async function appBackupFixture(t: TestContext) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-backup-')),
  );
  const app = join(base, '应用数据 with spaces');
  const root = join(base, '项目素材 中文');
  await mkdir(app);
  await mkdir(root);
  const database = join(app, 'app.sqlite');
  const store = new AppStore(database, root);
  const gate = new WriteGate();
  const projects = new ProjectService(store, gate);
  const first = await projects.create('索引保留项目 🎬');
  const second = await projects.create('独立项目');
  const staging = new Staging(join(app, 'staging'), store, () => {});
  const bytes = Buffer.from('完整待保存结果，不在应用索引备份中\n'.repeat(512));
  const job = await staging.receive(
    {
      projectId: first.project.id,
      resultKey: 'reference:backup-fixture',
      kind: 'text',
      usage: 'reference',
      extension: 'txt',
      name: '完整待保存文本.txt',
    },
    Readable.from(bytes),
  );
  assert.equal(job.status, 'ready');
  store.set('fixturePreference', { title: '备份时设置', value: 12 });
  const settings = { ...defaultInteractionSettings(), longPressSplit: false };
  store.set('interactions', settings);
  const backups = new AppBackupService(store, app, gate, 'test-version');
  await backups.initialize();
  let storeOpen = true;
  const close = async () => {
    await backups.close();
    await staging.idle();
    if (storeOpen) {
      storeOpen = false;
      await store.close();
    }
  };
  t.after(async () => {
    await close();
    await rm(base, { recursive: true, force: true });
  });
  return {
    base,
    app,
    root,
    database,
    store,
    gate,
    projects,
    first,
    second,
    staging,
    job,
    bytes,
    settings,
    backups,
    close,
  };
}
