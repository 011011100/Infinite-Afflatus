import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MediaToolSettings } from '../../src/main/media/media-tool-settings';
import type { AppStore } from '../../src/main/storage/app-store';
import type {
  MediaToolLocation,
  MediaToolPaths,
  MediaToolResult,
} from '../../src/shared/media-tools';
import type { ProjectSummary } from '../../src/shared/models';
import { assertOriginalFiles, fileHash, type HistoricalData } from './history';

export interface MediaToolUpgradeContract {
  writerCommit: string;
  app: string;
  defaultRoot: string;
  expected: HistoricalData;
  settings: { key: string; value: string }[];
  projects: ProjectSummary[];
  files: { file: string; size: number; sha256: string }[];
  raw: string | null;
  paths: MediaToolPaths | null;
  inspections: { name: string; command: string }[];
}

export function rawMediaToolSetting(app: string) {
  const db = new DatabaseSync(join(app, 'app.sqlite'), { readOnly: true });
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'mediaToolSettings'")
      .get();
    return row ? String(row.value) : null;
  } finally {
    db.close();
  }
}

export function settingsService(store: AppStore) {
  const inspections: MediaToolLocation[] = [];
  return {
    inspections,
    service: new MediaToolSettings(store, {
      env: {},
      platform: 'linux',
      inspect: async (location): Promise<MediaToolResult> => {
        inspections.push(location);
        return {
          ...location,
          status: 'available',
          version: 'storage-fixture-v1',
          detail: null,
        };
      },
    }),
  };
}

export async function assertMediaToolPreservation(
  contract: MediaToolUpgradeContract,
  store: AppStore,
) {
  assert.equal(store.root, contract.expected.root);
  assert.deepEqual(store.projects(), contract.projects);
  assert.deepEqual(store.jobs(), contract.expected.jobs);
  assert.deepEqual(
    store.job(contract.expected.queued.id),
    contract.expected.queued,
  );
  assert.equal(store.job(contract.expected.queued.id).status, 'ready');
  const db = new DatabaseSync(join(contract.app, 'app.sqlite'), {
    readOnly: true,
  });
  try {
    assert.deepEqual(
      db
        .prepare(
          "SELECT key, value FROM settings WHERE key <> 'mediaToolSettings' ORDER BY key",
        )
        .all()
        .map((row) => ({ key: String(row.key), value: String(row.value) })),
      contract.settings,
    );
  } finally {
    db.close();
  }
  assert.equal(rawMediaToolSetting(contract.app), contract.raw);
  for (const file of contract.files) {
    assert.equal((await readFile(file.file)).length, file.size, file.file);
    assert.equal(await fileHash(file.file), file.sha256, file.file);
  }
  await assertOriginalFiles(contract.expected);
  await assert.rejects(access(contract.defaultRoot), { code: 'ENOENT' });
}

export async function assertSettingsRead(
  contract: MediaToolUpgradeContract,
  store: AppStore,
) {
  const { service, inspections } = settingsService(store);
  try {
    const state = service.state();
    assert.deepEqual(state.paths, contract.paths);
    if (contract.paths) {
      assert.equal(state.error, null);
      const snapshot = service.snapshot();
      for (const name of ['ffmpeg', 'ffprobe'] as const) {
        assert.equal(snapshot[name].command, contract.paths[name] ?? name);
        assert.equal(
          snapshot[name].source,
          contract.paths[name] ? 'saved' : 'path',
        );
      }
      assert.equal((await service.check()).tools.length, 2);
      assert.equal(inspections.length, 2);
    } else {
      assert.ok(state.error);
      assert.throws(() => service.snapshot(), /配置损坏或版本不受支持/);
      let pickerCalled = false;
      await assert.rejects(
        service.choose(
          'ffmpeg',
          async () => {
            pickerCalled = true;
            return null;
          },
          () => {},
        ),
        /配置损坏或版本不受支持/,
      );
      await assert.rejects(
        service.reset('ffprobe', () => {}),
        /配置损坏或版本不受支持/,
      );
      assert.equal(pickerCalled, false);
      assert.equal(inspections.length, 0);
    }
    assert.equal(rawMediaToolSetting(contract.app), contract.raw);
  } finally {
    await service.close();
  }
}
