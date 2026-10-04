import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppBackupService } from '../src/main/backups/app-backup-service';
import { GENERATION_KEY } from '../src/main/backups/backup-anchor';
import { AppStore } from '../src/main/storage/app-store';
import { Library } from '../src/main/storage/library';
import { WriteGate } from '../src/main/storage/write-gate';
import { defaultInteractionSettings } from '../src/shared/interaction/settings';

for (const changeContents of [false, true]) {
  test(`initial generation write interruption ${changeContents ? 'rejects changed contents in the same original inode' : 'resumes only the exact original tokenless database'}`, async (t) => {
    const base = await realpath(
      await mkdtemp(join(tmpdir(), 'afflatus-anchor-init-')),
    );
    t.after(() => rm(base, { recursive: true, force: true }));
    const app = join(base, '应用资料');
    const root = join(base, '项目原目录');
    await mkdir(app);
    await mkdir(root);
    const file = join(app, 'app.sqlite');
    const store = new AppStore(file, root);
    const backups = new AppBackupService(store, app, new WriteGate());
    t.after(async () => {
      await backups.close();
      await store.close();
    });
    const set = store.set.bind(store);
    const fault = t.mock.method(store, 'set', (key: string, value: unknown) => {
      if (key === GENERATION_KEY)
        throw new Error('fixture token write unavailable');
      set(key, value);
    });
    await assert.rejects(backups.initialize(), /token write unavailable/);
    assert.equal(store.get(GENERATION_KEY), null);
    const anchor = JSON.parse(
      await readFile(join(app, 'app-backup-anchor.json'), 'utf8'),
    );
    assert.ok(anchor.initializing?.sha256);
    const original = await stat(file);
    if (changeContents)
      store.set('interactions', {
        ...defaultInteractionSettings(),
        longPressSplit: false,
      });
    fault.mock.restore();
    await backups.close();
    await store.close();
    const changed = await stat(file);
    assert.equal(changed.dev, original.dev);
    assert.equal(changed.ino, original.ino);
    const bytes = await readFile(file);
    if (changeContents) {
      await assert.rejects(Library.open(app, root), /内容|身份|认领/);
      assert.deepEqual(await readFile(file), bytes);
      assert.deepEqual(
        JSON.parse(await readFile(join(app, 'app-backup-anchor.json'), 'utf8')),
        anchor,
      );
    } else {
      const library = await Library.open(app, root);
      try {
        assert.deepEqual(library.store.get(GENERATION_KEY), {
          profileId: anchor.profileId,
          generation: anchor.generation,
        });
        assert.equal(
          JSON.parse(
            await readFile(join(app, 'app-backup-anchor.json'), 'utf8'),
          ).initializing,
          null,
        );
        assert.equal((await library.backups.create()).restorable, true);
      } finally {
        await library.close();
      }
    }
  });
}
